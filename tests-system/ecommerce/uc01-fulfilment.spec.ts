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
 * UC01 order fulfilment orchestration, from the e-commerce acceptance spec.
 * Five cases: the seven-step happy path, a declined payment that must halt
 * before any warehouse work, a zero-stock branch that parks for restock, a
 * shipping API that times out twice then succeeds under the retry policy, and
 * a multi-day run that survives a restart of the runtime.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, client, login, runtimeUp } from '../harness.js';
import { Externals } from './externals.js';
import {
  awaitSignal,
  branch,
  callNode,
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
  stop,
  until,
  withPolicy,
  type Api,
} from './shop.js';

const up = await runtimeUp();
const suite = up ? describe : describe.skip;
if (!up) {
  // eslint-disable-next-line no-console
  console.warn(`[ecommerce] no runtime at ${BASE}; skipping. Start the stack or set METIS_URL.`);
}

suite('UC01 order fulfilment orchestration', () => {
  const externals = new Externals();
  let api: Api;
  let wf: string;

  beforeAll(async () => {
    await externals.start();
    api = client(await login());
    const created = await api<{ workflowId: string }>('POST', '/api/workflows', {
      name: `uc01-fulfilment-${Date.now()}`,
      type: 'workflow',
      nodes: [step('return { seeded: true };', 'seed')],
      edges: [],
    });
    wf = created.body.workflowId;
  });

  afterAll(async () => {
    // Cancel anything a failed case left parked, so the next file starts clean.
    await cancelStragglers(api);
    await externals.stop();
  });

  it('TC01.1 order flows from placed to delivered', async () => {
    externals.reset();
    externals.script('/psp/capture', [{ status: 200, body: { captureId: 'cap_1' } }]);
    externals.script('/fraud/check', [{ status: 200, body: { risk: 12 } }]);
    externals.script('/inventory/reserve', [{ status: 200, body: { reserved: 1 } }]);
    externals.script('/warehouse/notify', [{ status: 200, body: { queued: true } }]);
    externals.script('/courier/label', [{ status: 200, body: { tracking: 'TRK-1001' } }]);

    const order = step('return { orderId: "ord-1", total: 150 };', 'place order');
    const capture = callNode(externals, '/psp/capture', { label: 'capture payment', body: { amount: 150 } });
    const fraud = callNode(externals, '/fraud/check', { label: 'fraud check' });
    const reserve = callNode(externals, '/inventory/reserve', { label: 'reserve inventory' });
    const warehouse = callNode(externals, '/warehouse/notify', { label: 'notify warehouse' });
    const label = callNode(externals, '/courier/label', { label: 'shipping label' });
    const email = callNode(externals, '/email/send', {
      label: 'tracking email',
      body: { template: 'dispatched', tracking: `{{${label.id}.data.data.tracking}}` },
    });
    const chain = [order, capture, fraud, reserve, warehouse, label, email];

    const executionId = await startRun(
      api,
      wf,
      chain,
      chain.slice(0, -1).map((n, i) => edge(n.id, chain[i + 1].id)),
    );
    const run = await until(api, executionId, settled, 40000);

    expect(run.meta.status).toBe('completed');
    for (const n of chain) expect(outcomeOf(run.logs, n.id)).toBe('completed');

    // The outside world saw each step exactly once, in order.
    expect(externals.succeeded('/courier/label')).toHaveLength(1);
    const sent = externals.calls('/email/send');
    expect(sent).toHaveLength(1);
    expect((sent[0].body as { tracking?: string }).tracking).toBe('TRK-1001');
    const order_of_calls = externals.calls().map((c) => c.path);
    expect(order_of_calls).toEqual([
      '/psp/capture',
      '/fraud/check',
      '/inventory/reserve',
      '/warehouse/notify',
      '/courier/label',
      '/email/send',
    ]);

    // Audit: every step has a start and a terminal line in the run log.
    for (const n of chain) {
      expect(run.logs.filter((l) => l.nodeId === n.id && l.event === 'workflow.node.started')).toHaveLength(1);
    }
  }, 60000);

  it('TC01.2 payment capture fails, the workflow halts and notifies', async () => {
    externals.reset();
    externals.script('/psp/capture', [{ status: 402, body: { reason: 'Card declined' } }]);

    const order = step('return { orderId: "ord-2" };', 'place order');
    const capture = callNode(externals, '/psp/capture', { label: 'capture payment' });
    const paid = branch([{ id: 'ok', property: `{{${capture.id}.data.status}}`, checkValue: 200 }], 'paid?');
    const reserve = callNode(externals, '/inventory/reserve', { label: 'reserve inventory' });
    const warehouse = callNode(externals, '/warehouse/notify', { label: 'notify warehouse' });
    const notify = callNode(externals, '/email/send', {
      label: 'payment failure email',
      body: { template: 'payment-failed', reason: `{{${capture.id}.data.data.reason}}` },
    });
    const halt = stop(`Card declined: {{${capture.id}.data.data.reason}}`, 'halt');

    const executionId = await startRun(
      api,
      wf,
      [order, capture, paid, reserve, warehouse, notify, halt],
      [
        edge(order.id, capture.id),
        edge(capture.id, paid.id),
        { ...edge(paid.id, reserve.id), sourceHandle: 'source-ok' },
        edge(reserve.id, warehouse.id),
        { ...edge(paid.id, notify.id), sourceHandle: 'source-default' },
        edge(notify.id, halt.id),
      ],
    );
    const run = await until(api, executionId, settled, 40000);

    expect(run.meta.status).toBe('failed');
    // Downstream fulfilment never ran.
    expect(startCount(run.logs, reserve.id)).toBe(0);
    expect(startCount(run.logs, warehouse.id)).toBe(0);
    expect(externals.calls('/inventory/reserve')).toHaveLength(0);
    expect(externals.calls('/warehouse/notify')).toHaveLength(0);
    // The customer was told, and the reason is legible in the run.
    const mail = externals.calls('/email/send');
    expect(mail).toHaveLength(1);
    expect((mail[0].body as { reason?: string }).reason).toBe('Card declined');
    expect(JSON.stringify(run.logs)).toMatch(/Card declined/);
  }, 60000);

  it('TC01.3 inventory unavailable branches to backorder and parks for restock', async () => {
    externals.reset();
    externals.script('/psp/capture', [{ status: 200, body: { captureId: 'cap_3', captured: false } }]);
    externals.script('/inventory/check', [{ status: 200, body: { available: 0 } }]);

    const order = step('return { orderId: "ord-3" };', 'place order');
    const capture = callNode(externals, '/psp/capture', { label: 'authorise payment' });
    const stock = callNode(externals, '/inventory/check', { label: 'check stock' });
    const inStock = branch(
      [{ id: 'yes', property: `{{${stock.id}.data.data.available}}`, checkValue: 0, checkOperator: '>' }],
      'in stock?',
    );
    const reserve = callNode(externals, '/inventory/reserve', { label: 'reserve inventory' });
    const backorder = callNode(externals, '/email/send', {
      label: 'backorder email',
      body: { template: 'backorder' },
    });
    const restock = awaitSignal('restocked', { label: 'await restock' });
    const resume = callNode(externals, '/warehouse/notify', { label: 'notify warehouse' });

    const executionId = await startRun(
      api,
      wf,
      [order, capture, stock, inStock, reserve, backorder, restock, resume],
      [
        edge(order.id, capture.id),
        edge(capture.id, stock.id),
        edge(stock.id, inStock.id),
        { ...edge(inStock.id, reserve.id), sourceHandle: 'source-yes' },
        { ...edge(inStock.id, backorder.id), sourceHandle: 'source-default' },
        edge(backorder.id, restock.id),
        edge(restock.id, resume.id),
      ],
    );

    // It parks on the backorder branch: no reservation, customer told.
    await until(api, executionId, nodeWaiting(restock.id), 40000);
    const parked = await detail(api, executionId);
    expect(parked.meta.status).toBe('running');
    expect(startCount(parked.logs, reserve.id)).toBe(0);
    expect(externals.calls('/email/send')).toHaveLength(1);
    expect(externals.calls('/inventory/reserve')).toHaveLength(0);

    // Stock arrives: the parked run resumes from the right step.
    expect(await sendSignal(api, executionId, 'restocked', { units: 5 })).toBe(202);
    const done = await until(api, executionId, settled, 40000);
    expect(done.meta.status).toBe('completed');
    expect(externals.calls('/warehouse/notify')).toHaveLength(1);
  }, 90000);

  it('TC01.4 shipping API times out, the retry policy recovers without a duplicate label', async () => {
    externals.reset();
    externals.script('/courier/label', [
      { delayMs: 3000 },
      { delayMs: 3000 },
      { status: 200, body: { tracking: 'TRK-1004' } },
    ]);

    const order = step('return { orderId: "ord-4" };', 'place order');
    const label = withPolicy(
      callNode(externals, '/courier/label', { label: 'shipping label', timeoutMs: 1000 }),
      { retries: 3, backoffSeconds: 1, timeoutSeconds: 10 },
    );
    const email = callNode(externals, '/email/send', {
      label: 'tracking email',
      body: { tracking: `{{${label.id}.data.data.tracking}}` },
    });

    const executionId = await startRun(
      api,
      wf,
      [order, label, email],
      [edge(order.id, label.id), edge(label.id, email.id)],
    );
    const run = await until(api, executionId, settled, 60000);

    expect(run.meta.status).toBe('completed');
    expect(outcomeOf(run.logs, label.id)).toBe('completed');
    // No human touched it, and only ONE label exists.
    expect(externals.succeeded('/courier/label')).toHaveLength(1);
    expect(externals.calls('/courier/label').length).toBeGreaterThanOrEqual(3);
    expect((externals.calls('/email/send')[0].body as { tracking?: string }).tracking).toBe('TRK-1004');
    // The attempts are visible in run history, not just counted internally.
    const labelLine = run.logs.filter((l) => l.nodeId === label.id && l.outcome).at(-1) as
      | { attempts?: number }
      | undefined;
    expect(labelLine?.attempts).toBe(3);
  }, 90000);

  it('TC01.5 a multi-day fulfilment survives a restart of the runtime', async () => {
    externals.reset();
    externals.script('/warehouse/notify', [{ status: 200, body: { queued: true } }]);
    externals.script('/courier/label', [{ status: 200, body: { tracking: 'TRK-1005' } }]);

    const order = step('return { orderId: "ord-5" };', 'place order');
    const warehouse = callNode(externals, '/warehouse/notify', { label: 'notify warehouse' });
    // Day 1 ends here. The real thing waits days; the shape is identical.
    const dispatch = awaitSignal('warehouse.dispatched', { label: 'await dispatch' });
    const label = callNode(externals, '/courier/label', { label: 'shipping label' });

    const executionId = await startRun(
      api,
      wf,
      [order, warehouse, dispatch, label],
      [edge(order.id, warehouse.id), edge(warehouse.id, dispatch.id), edge(dispatch.id, label.id)],
    );
    await until(api, executionId, nodeWaiting(dispatch.id), 40000);

    await restartRuntime();
    await runtimeBack(BASE);
    api = client(await login());

    // Day 3: the warehouse ships. The parked run must still be there.
    expect(await sendSignal(api, executionId, 'warehouse.dispatched', { at: 'day-3' })).toBe(202);
    const done = await until(api, executionId, settled, 60000);

    expect(done.meta.status).toBe('completed');
    expect(externals.succeeded('/courier/label')).toHaveLength(1);
    // Nothing re-executed across the restart.
    for (const n of [order, warehouse]) expect(startCount(done.logs, n.id)).toBe(1);
    expect(externals.calls('/warehouse/notify')).toHaveLength(1);
  }, 180000);

});
