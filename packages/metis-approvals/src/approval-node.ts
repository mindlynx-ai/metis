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
 * The Approval node handler. It runs twice per decision, which is the whole
 * trick: the first dispatch raises the request and asks the engine to park
 * on a signal, and the dispatch that follows the park carries the answer.
 * No new durable primitive is introduced; the wait is the same Temporal
 * condition a signal node has always used.
 *
 * The completed step's output IS the audit record, so the run's own log
 * answers "who approved the thing that moved the money" without a second
 * store to keep in step with it.
 */
import {
  NODE_STATUS,
  parkOnSignal,
  stateEnvelope,
  type NodeExecutionResult,
  type NodeHandler,
  type NodeHandlerContext,
  type NodeHandlerRegistry,
} from '@mindlynx/metis-ports';
import {
  approvalSignalType,
  buildApprovalRequest,
  isEscalatedSignal,
  partitionByDecision,
  readApprovalConfig,
  resolveDecision,
  type ApprovalConfig,
} from './approval-decision.js';

/** Raise (or re-raise) the request and hand the wait back to the engine. */
function raise(
  ctx: NodeHandlerContext,
  config: ApprovalConfig,
  extra: { escalated?: true; refused?: string } = {},
): NodeExecutionResult {
  const request = buildApprovalRequest(config, extra);
  return parkOnSignal(
    {
      signalType: approvalSignalType(ctx.nodeRef.id, extra.escalated === true),
      timeoutMs: config.slaMs,
      details: request,
    },
    extra.escalated ? `escalated: ${config.title}` : `awaiting sign-off: ${config.title}`,
  );
}

export function createApprovalNodeHandler(): NodeHandler {
  return async (ctx: NodeHandlerContext): Promise<NodeExecutionResult> => {
    // A config this handler cannot read throws, and the registry turns that
    // into a failed node: better a run that stops now than a gate parked on
    // a question nobody can answer.
    const config = readApprovalConfig(ctx.nodeRef.config ?? {});
    const params = ctx.nodeRef.signalParams;
    if (params === undefined) return raise(ctx, config);

    const outcome = resolveDecision(config, params, new Date().toISOString());
    if (outcome.verdict === 'fail') return { status: NODE_STATUS.failed, message: outcome.message };
    if (outcome.verdict === 'escalate') return raise(ctx, config, { escalated: true });
    if (outcome.verdict === 'refused') {
      // Nothing was decided, so the approval goes back into the queue with
      // the reason attached. ponytail: a refusal after an escalation loses
      // the urgent flag; re-raise carrying it when the badge starts mattering.
      return raise(ctx, config, { refused: outcome.refused });
    }

    const record = {
      ...outcome.record,
      ...(isEscalatedSignal((params as { signalType?: unknown }).signalType) ? { escalated: true as const } : {}),
    };
    const partition = partitionByDecision(ctx.targets ?? [], record.decision);
    return {
      status: NODE_STATUS.ok,
      message: `${record.decision} by ${record.approver ?? 'nobody: the SLA ran out'}`,
      nodeData: stateEnvelope(ctx.nodeRef.id, ctx.nodeRef.type, { ...record, ...partition }),
    };
  };
}

/** Register the paid approval types on the open registry: the plugin seam. */
export function registerApprovalNodes(registry: NodeHandlerRegistry): NodeHandlerRegistry {
  registry.registerNodeHandler('approval', createApprovalNodeHandler());
  return registry;
}
