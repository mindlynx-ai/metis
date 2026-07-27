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
 * UC09 supplier and dropship coordination: purchase orders that wait a day
 * for an acknowledgement, chases when none comes, two suppliers running in
 * parallel for one customer order, and a supplier API that keeps timing out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, client, login, runtimeUp } from '../harness.js';
import { Externals } from './externals.js';
import {
  awaitSignal,
  callNode,
  cancelStragglers,
  edge,
  nodeWaiting,
  outcomeOf,
  sendSignal,
  settled,
  startCount,
  startRun,
  step,
  until,
  wait,
  withPolicy,
  type Api,
} from './shop.js';

const up = await runtimeUp();
const suite = up ? describe : describe.skip;
if (!up) {
  // eslint-disable-next-line no-console
  console.warn(`[ecommerce] no runtime at ${BASE}; skipping. Start the stack or set METIS_URL.`);
}

suite('UC09 supplier and dropship coordination', () => {
  const externals = new Externals();
  let api: Api;
  let wf: string;

  beforeAll(async () => {
    await externals.start();
    api = client(await login());
    const created = await api<{ workflowId: string }>('POST', '/api/workflows', {
      name: `uc09-suppliers-${Date.now()}`,
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

  it('TC09.1 a purchase order waits durably for the acknowledgement', async () => {
    externals.reset();
    externals.script('/supplier/po', [{ status: 200, body: { poRef: 'PO-1001' } }]);
    externals.script('/warehouse/expect', [{ status: 200, body: { booked: true } }]);

    const draft = step('return { poRef: "PO-1001", supplier: "acme", qty: 100 };', 'create PO');
    const send = callNode(externals, '/supplier/po', { label: 'send PO' });
    send.data.config.body = { poRef: `{{${draft.id}.data.poRef}}`, qty: `{{${draft.id}.data.qty}}` };
    // Up to 24 hours in production; the shape is a durable park either way.
    const ack = awaitSignal('supplier.ack', { label: 'await acknowledgement' });
    const expected = callNode(externals, '/warehouse/expect', { label: 'book expected shipment' });

    const executionId = await startRun(
      api,
      wf,
      [draft, send, ack, expected],
      [edge(draft.id, send.id), edge(send.id, ack.id), edge(ack.id, expected.id)],
    );
    await until(api, executionId, nodeWaiting(ack.id), 30000);

    // Nothing downstream moved while the supplier was silent.
    expect(startCount((await until(api, executionId, () => true, 5000)).logs, expected.id)).toBe(0);
    expect(await sendSignal(api, executionId, 'supplier.ack', { poRef: 'PO-1001' })).toBe(202);

    const run = await until(api, executionId, settled, 40000);
    expect(run.meta.status).toBe('completed');
    expect((externals.calls('/supplier/po')[0].body as { qty?: number }).qty).toBe(100);
    expect(externals.succeeded('/warehouse/expect')).toHaveLength(1);
  }, 90000);

  it('TC09.2 silence past the window chases the supplier and tells the buyer', async () => {
    externals.reset();
    externals.script('/supplier/po', [{ status: 200, body: { poRef: 'PO-1002' } }]);
    externals.script('/email/send', [{ status: 200, body: { sent: true } }]);
    externals.script('/slack/chat.postMessage', [{ status: 200, body: { ok: true } }]);

    const draft = step('return { poRef: "PO-1002", supplier: "acme", contact: "sales@acme.test" };', 'create PO');
    const send = callNode(externals, '/supplier/po', { label: 'send PO' });
    const window = wait(3, 'wait 24 hours for the ack');
    const chase = callNode(externals, '/email/send', { label: 'chase the supplier' });
    chase.data.config.body = {
      template: 'po-chase',
      to: `{{${draft.id}.data.contact}}`,
      poRef: `{{${draft.id}.data.poRef}}`,
    };
    const tellBuyer = callNode(externals, '/slack/chat.postMessage', { label: 'notify buyer' });
    tellBuyer.data.config.body = { channel: '#buying', text: 'No ack on PO-1002 after 24h' };

    const executionId = await startRun(
      api,
      wf,
      [draft, send, window, chase, tellBuyer],
      [edge(draft.id, send.id), edge(send.id, window.id), edge(window.id, chase.id), edge(chase.id, tellBuyer.id)],
    );
    const run = await until(api, executionId, settled, 40000);

    expect(run.meta.status).toBe('completed');
    // The chase carries the PO reference and the supplier contact.
    const chased = externals.calls('/email/send');
    expect(chased).toHaveLength(1);
    expect((chased[0].body as { to?: string; poRef?: string }).to).toBe('sales@acme.test');
    expect((chased[0].body as { poRef?: string }).poRef).toBe('PO-1002');
    // The buyer knows too, and the chase came after the window, not before.
    expect(externals.succeeded('/slack/chat.postMessage')).toHaveLength(1);
    expect(chased[0].at - externals.calls('/supplier/po')[0].at).toBeGreaterThanOrEqual(2900);
  }, 60000);

  // The discrepancy maths is a switch; the buyer's accept / reject / reorder
  // decision needs the approval queue.
  it.todo('TC09.3 a shipment discrepancy goes to the buyer for a decision (needs the approval gate, Phase 5)');

  it('TC09.4 two suppliers run in parallel and the order waits for both', async () => {
    externals.reset();
    externals.script('/supplier/po', [
      { status: 200, body: { poRef: 'PO-A' } },
      { status: 200, body: { poRef: 'PO-B' } },
    ]);
    externals.script('/warehouse/consolidate', [{ status: 200, body: { ready: true } }]);

    const order = step('return { orderId: "ord-904", suppliers: ["acme", "globex"] };', 'customer order');
    const poA = callNode(externals, '/supplier/po', { label: 'PO to acme' });
    poA.data.config.body = { supplier: 'acme', orderId: 'ord-904' };
    const poB = callNode(externals, '/supplier/po', { label: 'PO to globex' });
    poB.data.config.body = { supplier: 'globex', orderId: 'ord-904' };
    const ackA = awaitSignal('supplier.acme.confirmed', { label: 'acme confirms' });
    const ackB = awaitSignal('supplier.globex.confirmed', { label: 'globex confirms' });
    // The join: one customer shipment, only once BOTH suppliers confirm.
    const consolidate = callNode(externals, '/warehouse/consolidate', { label: 'consolidate shipment' });

    const executionId = await startRun(
      api,
      wf,
      [order, poA, poB, ackA, ackB, consolidate],
      [
        edge(order.id, poA.id),
        edge(order.id, poB.id),
        edge(poA.id, ackA.id),
        edge(poB.id, ackB.id),
        edge(ackA.id, consolidate.id),
        edge(ackB.id, consolidate.id),
      ],
    );
    await until(api, executionId, (d) => nodeWaiting(ackA.id)(d) && nodeWaiting(ackB.id)(d), 30000);

    // One supplier confirms: the customer shipment must still wait.
    expect(await sendSignal(api, executionId, 'supplier.acme.confirmed', {})).toBe(202);
    await new Promise((r) => setTimeout(r, 1500));
    const halfWay = await until(api, executionId, () => true, 5000);
    expect(halfWay.meta.status).toBe('running');
    expect(externals.calls('/warehouse/consolidate')).toHaveLength(0);

    expect(await sendSignal(api, executionId, 'supplier.globex.confirmed', {})).toBe(202);
    const run = await until(api, executionId, settled, 40000);

    expect(run.meta.status).toBe('completed');
    expect(externals.calls('/supplier/po')).toHaveLength(2);
    // The join ran once, after both threads.
    expect(externals.succeeded('/warehouse/consolidate')).toHaveLength(1);
    expect(startCount(run.logs, consolidate.id)).toBe(1);
  }, 120000);

  it('TC09.5 a flaky supplier API is retried with backoff and the PO is sent once', async () => {
    externals.reset();
    externals.script('/supplier/po', [
      { delayMs: 3000 },
      { delayMs: 3000 },
      { status: 200, body: { poRef: 'PO-905' } },
    ]);

    const draft = step('return { poRef: "PO-905" };', 'create PO');
    const send = withPolicy(
      callNode(externals, '/supplier/po', { label: 'send PO', timeoutMs: 800 }),
      { retries: 3, backoffSeconds: 1, timeoutSeconds: 15, idempotencyKey: 'po-send' },
    );

    const executionId = await startRun(api, wf, [draft, send], [edge(draft.id, send.id)]);
    const run = await until(api, executionId, settled, 60000);

    expect(run.meta.status).toBe('completed');
    expect(outcomeOf(run.logs, send.id)).toBe('completed');
    // Retries are on the record, and the supplier only ever accepted one PO.
    const line = run.logs.filter((l) => l.nodeId === send.id && l.outcome).at(-1) as
      | { attempts?: number }
      | undefined;
    expect(line?.attempts).toBe(3);
    expect(externals.succeeded('/supplier/po')).toHaveLength(1);
    // The earlier attempts still reached the supplier before timing out, so
    // every attempt carries the SAME idempotency key: a supplier that acted on
    // a request it answered too slowly recognises the retry as the same PO.
    const keys = new Set(externals.calls('/supplier/po').map((c) => c.idempotencyKey));
    expect(externals.calls('/supplier/po').length).toBeGreaterThanOrEqual(3);
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBeTruthy();
  }, 90000);
});
