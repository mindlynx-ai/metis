/*
 * Copyright 2026 Seillen Ltd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The durable wait on a decision from outside the run (workflow-side,
 * deterministic). It is the signal node's park, opened up to handlers: the
 * same Temporal condition, the same cancel race, the same waiting log line,
 * but the signal name and the deadline come from the handler that asked.
 *
 * The expiry is deliberately NOT a decision made here. A timed-out sign-off
 * could safely mean reject for one workflow and escalate for another, and an
 * engine that guessed would eventually guess "approve". So the node is
 * dispatched again carrying the expiry, and its handler applies its own rule.
 */
import { condition, proxyActivities } from '@temporalio/workflow';
import {
  MAX_SIGNAL_PARKS,
  PARK_EXPIRED,
  SIGNAL_DEFAULT_TIMEOUT_MS,
  type EngineActivities,
  type ExecuteNodeResult,
  type RuntimeNode,
  type SignalParkRequest,
} from '../types.js';

const parkActivities = proxyActivities<Pick<EngineActivities, 'markNodeWaiting'>>({
  startToCloseTimeout: '2 minutes',
});

export interface ExecutionIds {
  tenantId: string;
  workflowId: string;
  executionId: string;
}

/** The answer to a park: the signal's params, the engine's expiry, or a stop. */
export type DecisionOutcome = { cancelled: true } | { answer: unknown };

/** What the walk needs to lend the park: its counter and its dispatch. */
export interface DecisionRound {
  isCancelled(): boolean;
  nextSequence(): number;
  dispatch(sequence: number): Promise<ExecuteNodeResult>;
}

/**
 * Wait out every park this node asks for, and return its settled result.
 * A handler may park again after seeing the answer (escalating an expired
 * approval), so this is a loop; the cap is what stops a handler that parks
 * on every dispatch from growing history for ever without ever failing.
 */
export async function settleDecisions(
  ids: ExecutionIds,
  node: RuntimeNode,
  first: ExecuteNodeResult,
  round: DecisionRound,
): Promise<ExecuteNodeResult | 'cancelled'> {
  let result = first;
  let parks = 0;
  while (result.outcome === 'parked' && result.park) {
    parks += 1;
    if (parks > MAX_SIGNAL_PARKS) {
      return {
        outcome: 'failed',
        error: { message: `node ${node.id} parked ${parks} times without settling a decision` },
      };
    }
    const decision = await awaitDecision(ids, node, result.park, round.nextSequence(), round.isCancelled);
    if ('cancelled' in decision) return 'cancelled';
    node.signalParams = decision.answer;
    result = await round.dispatch(round.nextSequence());
  }
  return result;
}

/**
 * Park the node on `park.signalType` until the signal lands, the run is
 * cancelled, or the deadline passes.
 */
export async function awaitDecision(
  ids: ExecutionIds,
  node: RuntimeNode,
  park: SignalParkRequest,
  sequence: number,
  isCancelled: () => boolean,
): Promise<DecisionOutcome> {
  const timeoutMs = park.timeoutMs && park.timeoutMs > 0 ? park.timeoutMs : SIGNAL_DEFAULT_TIMEOUT_MS;
  // Claim the signal name BEFORE the wait: an answer that arrives while the
  // markNodeWaiting activity is still in flight would otherwise find no node
  // listening and be dropped.
  node.awaitingSignalType = park.signalType;
  node.signalReceived = false;
  node.signalParams = undefined;
  await parkActivities.markNodeWaiting({
    ...ids,
    nodeId: node.id,
    nodeType: node.type,
    signalType: park.signalType,
    until: new Date(Date.now() + timeoutMs).toISOString(),
    details: park.details,
    sequence,
  });
  const answered = await condition(() => node.signalReceived === true || isCancelled(), timeoutMs);
  node.awaitingSignalType = undefined;
  if (isCancelled()) return { cancelled: true };
  // The expiry names the park it ended, so a handler that parks more than
  // once (an escalation) can tell which of its deadlines just passed.
  return { answer: answered ? node.signalParams : { ...PARK_EXPIRED, signalType: park.signalType } };
}
