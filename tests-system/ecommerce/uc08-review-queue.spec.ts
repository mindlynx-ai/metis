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
 * UC08 fraud and order review queues. This use case IS the governance tier:
 * every case needs a human decision inside a run, an SLA timer on that
 * decision, an escalation when it lapses, and an audit trail of who decided
 * what. None of that exists yet (cap.approvals is a coming-soon capability),
 * so all five cases wait on the approval gate.
 *
 * The half that does exist is proven elsewhere: parking a run on an outside
 * event (TC01.3, TC05.1), timers and escalation windows (TC04.4, TC09.2),
 * and cancelling cleanly with the right customer comms (TC04.2, TC05.4).
 * What is missing is the queue, the identity of the decider, and the record.
 *
 * When the approval node lands, each case below becomes: park on approval,
 * assert the queue entry carries the order context and risk factors, decide,
 * assert the run resumed on the right branch and the decision is in the log.
 */
import { describe, it } from 'vitest';
import { BASE, runtimeUp } from '../harness.js';

const up = await runtimeUp();
const suite = up ? describe : describe.skip;
if (!up) {
  // eslint-disable-next-line no-console
  console.warn(`[ecommerce] no runtime at ${BASE}; skipping. Start the stack or set METIS_URL.`);
}

suite('UC08 fraud and order review queues', () => {
  it.todo('TC08.1 a high-risk order is held in the review queue (needs the approval gate, Phase 5)');
  it.todo('TC08.2 an SLA breach escalates to a senior reviewer (needs SLA timers on approvals)');
  it.todo('TC08.3 an approval lets the order continue seamlessly (needs the approval gate)');
  it.todo('TC08.4 a rejection cancels the order and releases the authorisation (needs the approval gate)');
  it.todo('TC08.5 no decision in 48 hours auto-cancels with notice (needs approvals + escalation)');
});
