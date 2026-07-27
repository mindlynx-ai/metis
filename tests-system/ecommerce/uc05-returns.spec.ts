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
 * UC05 returns and RMA processing. A return is mostly waiting: for the parcel
 * to arrive, for a decision, for a customer who changes their mind. Two cases
 * (damaged goods and the CS fallback) need the approval queue and wait on it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, client, login, runtimeUp } from '../harness.js';
import { Externals } from './externals.js';
import {
  awaitSignal,
  callNode,
  cancelRun,
  cancelStragglers,
  detail,
  edge,
  nodeWaiting,
  outcomeOf,
  restartRuntime,
  runtimeBack,
  sendSignal,
  settled,
  startCount,
  startRun,
  step,
  until,
  type Api,
} from './shop.js';

const up = await runtimeUp();
const suite = up ? describe : describe.skip;
if (!up) {
  // eslint-disable-next-line no-console
  console.warn(`[ecommerce] no runtime at ${BASE}; skipping. Start the stack or set METIS_URL.`);
}

suite('UC05 returns and RMA processing', () => {
  const externals = new Externals();
  let api: Api;
  let wf: string;

  beforeAll(async () => {
    await externals.start();
    api = client(await login());
    const created = await api<{ workflowId: string }>('POST', '/api/workflows', {
      name: `uc05-returns-${Date.now()}`,
      type: 'workflow',
      nodes: [step('return { seeded: true };', 'seed')],
      edges: [],
    });
    wf = created.body.workflowId;
  });

  afterAll(async () => {
    await cancelStragglers(api);
    await externals.stop();
  });

  it('TC05.1 a return runs end to end from request to restock', async () => {
    externals.reset();
    externals.script('/returns/eligibility', [{ status: 200, body: { eligible: true, windowDays: 30 } }]);
    externals.script('/courier/return-label', [{ status: 200, body: { label: 'RET-1', tracking: 'RTN-77' } }]);
    externals.script('/warehouse/inspect', [{ status: 200, body: { condition: 'good' } }]);
    externals.script('/psp/refund', [{ status: 200, body: { refundId: 'ref_return_1' } }]);
    externals.script('/inventory/restock', [{ status: 200, body: { restocked: true } }]);

    const request = step('return { rma: "RMA-1", orderId: "ord-500" };', 'return requested');
    const eligibility = callNode(externals, '/returns/eligibility', { label: 'eligibility check' });
    const label = callNode(externals, '/courier/return-label', { label: 'return label' });
    const received = awaitSignal('return.received', { label: 'await parcel' });
    const inspect = callNode(externals, '/warehouse/inspect', { label: 'condition check' });
    const refund = callNode(externals, '/psp/refund', { label: 'issue refund' });
    const restock = callNode(externals, '/inventory/restock', { label: 'restock' });
    const chain = [request, eligibility, label, received, inspect, refund, restock];

    const executionId = await startRun(
      api,
      wf,
      chain,
      chain.slice(0, -1).map((n, i) => edge(n.id, chain[i + 1].id)),
    );
    await until(api, executionId, nodeWaiting(received.id), 30000);
    expect(await sendSignal(api, executionId, 'return.received', { at: 'depot' })).toBe(202);

    const run = await until(api, executionId, settled, 40000);
    expect(run.meta.status).toBe('completed');
    for (const n of chain) expect(outcomeOf(run.logs, n.id)).toBe('completed');
    // The money went back and the unit is sellable again.
    expect(externals.succeeded('/psp/refund')).toHaveLength(1);
    expect(externals.succeeded('/inventory/restock')).toHaveLength(1);
  }, 90000);

  // // Blocked twice over: no approval queue for the reviewer, and no object
    // store node to hand them the warehouse photos.
  it.todo('TC05.2 a damaged item goes to human review (needs the approval queue, Phase 5)');

  // // The retry half is proven by TC01.4 and TC02.3. What is missing is the
    // queue where CS picks up the parked task with the customer context.
  it.todo('TC05.3 label generation exhausts its retries and falls back to CS (needs the approval queue, Phase 5)');

  it('TC05.4 the customer keeps the item: the return cancels and the label is voided', async () => {
    externals.reset();
    externals.script('/courier/return-label', [{ status: 200, body: { label: 'RET-4' } }]);
    externals.script('/courier/void-label', [{ status: 200, body: { voided: true } }]);
    externals.script('/email/send', [{ status: 200, body: { sent: true } }]);

    const request = step('return { rma: "RMA-4" };', 'return requested');
    const label = callNode(externals, '/courier/return-label', { label: 'return label' });
    const received = awaitSignal('return.received', { label: 'await parcel' });
    const refund = callNode(externals, '/psp/refund', { label: 'issue refund' });

    const executionId = await startRun(
      api,
      wf,
      [request, label, received, refund],
      [edge(request.id, label.id), edge(label.id, received.id), edge(received.id, refund.id)],
    );
    await until(api, executionId, nodeWaiting(received.id), 30000);

    // The customer portal cancels: a second flow voids the label and confirms,
    // then stops the parked return.
    const voidLabel = callNode(externals, '/courier/void-label', { label: 'void label' });
    const confirm = callNode(externals, '/email/send', { label: 'cancellation email' });
    const cancelFlow = await startRun(
      api,
      wf,
      [voidLabel, confirm],
      [edge(voidLabel.id, confirm.id)],
    );
    await until(api, cancelFlow, settled, 30000);
    expect(await cancelRun(api, executionId, 'customer kept the item')).toBe(202);

    const run = await until(api, executionId, settled, 30000);
    expect(run.meta.status).toMatch(/cancel/i);
    // No refund, label void, customer told.
    expect(externals.calls('/psp/refund')).toHaveLength(0);
    expect(startCount(run.logs, refund.id)).toBe(0);
    expect(externals.succeeded('/courier/void-label')).toHaveLength(1);
    expect(externals.succeeded('/email/send')).toHaveLength(1);
  }, 90000);

  it('TC05.5 a parcel that takes weeks survives repeated restarts', async () => {
    externals.reset();
    externals.script('/courier/return-label', [{ status: 200, body: { label: 'RET-5' } }]);
    externals.script('/psp/refund', [{ status: 200, body: { refundId: 'ref_return_5' } }]);

    const request = step('return { rma: "RMA-5" };', 'return requested');
    const label = callNode(externals, '/courier/return-label', { label: 'return label' });
    const received = awaitSignal('return.received', { label: 'await parcel' });
    const refund = callNode(externals, '/psp/refund', { label: 'issue refund' });

    const executionId = await startRun(
      api,
      wf,
      [request, label, received, refund],
      [edge(request.id, label.id), edge(label.id, received.id), edge(received.id, refund.id)],
    );
    await until(api, executionId, nodeWaiting(received.id), 30000);

    // Three weeks of ordinary operations: the runtime restarts more than once.
    for (let i = 0; i < 2; i += 1) {
      await restartRuntime();
      await runtimeBack(BASE);
      api = client(await login());
      const stillThere = await detail(api, executionId);
      expect(stillThere.meta.status).toBe('running');
    }

    expect(await sendSignal(api, executionId, 'return.received', { week: 3 })).toBe(202);
    const run = await until(api, executionId, settled, 60000);

    expect(run.meta.status).toBe('completed');
    expect(externals.succeeded('/psp/refund')).toHaveLength(1);
    // Nothing before the wait ran twice, across two restarts.
    expect(startCount(run.logs, request.id)).toBe(1);
    expect(externals.calls('/courier/return-label')).toHaveLength(1);
  }, 240000);
});
