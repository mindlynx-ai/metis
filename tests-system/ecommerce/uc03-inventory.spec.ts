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
 * UC03 inventory sync and stock management. The multi-channel cases: a fan-out
 * to three sales channels, a threshold breach that raises a purchase order and
 * tells the buyer on Slack, one channel failing without taking the others with
 * it, and two orders racing for the last unit.
 *
 * TC03.5 (a big catalogue prompting the data uplift) is a UI behaviour, proven
 * in the browser pass rather than here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, client, login, runtimeUp } from '../harness.js';
import { Externals } from './externals.js';
import {
  branch,
  callNode,
  cancelStragglers,
  edge,
  outcomeOf,
  settled,
  startRun,
  step,
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

suite('UC03 inventory sync and stock management', () => {
  const externals = new Externals();
  let api: Api;
  let wf: string;

  beforeAll(async () => {
    await externals.start();
    api = client(await login());
    const created = await api<{ workflowId: string }>('POST', '/api/workflows', {
      name: `uc03-inventory-${Date.now()}`,
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

  it('TC03.1 a stock level reaches all three channels', async () => {
    externals.reset();
    for (const channel of ['/storefront/stock', '/amazon/stock', '/ebay/stock']) {
      externals.script(channel, [{ status: 200, body: { accepted: true } }]);
    }

    const warehouse = step('return { sku: "SKU-1", units: 100 };', 'warehouse reports stock');
    const storefront = callNode(externals, '/storefront/stock', { label: 'storefront' });
    const amazon = callNode(externals, '/amazon/stock', { label: 'amazon' });
    const ebay = callNode(externals, '/ebay/stock', { label: 'ebay' });
    for (const channel of [storefront, amazon, ebay]) {
      channel.data.config.body = { sku: `{{${warehouse.id}.data.sku}}`, units: `{{${warehouse.id}.data.units}}` };
    }
    const verify = step('return { synced: true };', 'verify all channels');

    const executionId = await startRun(
      api,
      wf,
      [warehouse, storefront, amazon, ebay, verify],
      [
        edge(warehouse.id, storefront.id),
        edge(warehouse.id, amazon.id),
        edge(warehouse.id, ebay.id),
        edge(storefront.id, verify.id),
        edge(amazon.id, verify.id),
        edge(ebay.id, verify.id),
      ],
    );
    const run = await until(api, executionId, settled, 40000);

    expect(run.meta.status).toBe('completed');
    // Every channel got the same number, as a number.
    for (const path of ['/storefront/stock', '/amazon/stock', '/ebay/stock']) {
      const call = externals.calls(path);
      expect(call).toHaveLength(1);
      expect((call[0].body as { units?: number }).units).toBe(100);
    }
    // The join ran once, after all three.
    expect(outcomeOf(run.logs, verify.id)).toBe('completed');
    expect(run.logs.filter((l) => l.nodeId === verify.id && l.event === 'workflow.node.started')).toHaveLength(1);
  }, 60000);

  it('TC03.2 a threshold breach raises one purchase order and tells the buyer', async () => {
    externals.reset();
    externals.script('/supplier/po', [{ status: 200, body: { poId: 'PO-9001' } }]);
    externals.script('/slack/chat.postMessage', [{ status: 200, body: { ok: true, ts: '1.1' } }]);

    const sale = step('return { sku: "SKU-2", stock: 18, threshold: 20, reorderQty: 50 };', 'sale reduces stock');
    const belowThreshold = branch(
      [{ id: 'low', property: `{{${sale.id}.data.stock}}`, checkValue: 20, checkOperator: '<' }],
      'below threshold?',
    );
    const po = callNode(externals, '/supplier/po', { label: 'draft purchase order' });
    po.data.config.body = { sku: `{{${sale.id}.data.sku}}`, qty: `{{${sale.id}.data.reorderQty}}` };
    const slack = callNode(externals, '/slack/chat.postMessage', { label: 'notify buyer' });
    slack.data.config.body = { channel: '#buying', text: 'Reorder drafted for SKU-2' };
    const noop = step('return { skipped: true };', 'no reorder needed');

    const executionId = await startRun(
      api,
      wf,
      [sale, belowThreshold, po, slack, noop],
      [
        edge(sale.id, belowThreshold.id),
        { ...edge(belowThreshold.id, po.id), sourceHandle: 'source-low' },
        edge(po.id, slack.id),
        { ...edge(belowThreshold.id, noop.id), sourceHandle: 'source-default' },
      ],
    );
    const run = await until(api, executionId, settled, 40000);

    expect(run.meta.status).toBe('completed');
    // Exactly one PO, for the configured reorder quantity.
    const orders = externals.calls('/supplier/po');
    expect(orders).toHaveLength(1);
    expect((orders[0].body as { qty?: number }).qty).toBe(50);
    // The buyer heard about it on Slack, through the real connector path.
    expect(externals.calls('/slack/chat.postMessage')).toHaveLength(1);
    // The one-click approve on that Slack message is the approval gate (Phase 5).
  }, 60000);

  it('TC03.3 one channel failing does not block the others', async () => {
    externals.reset();
    externals.script('/storefront/stock', [{ status: 200, body: { accepted: true } }]);
    externals.script('/ebay/stock', [{ status: 200, body: { accepted: true } }]);
    // Amazon hangs twice before recovering: the node fails, the policy retries.
    externals.script('/amazon/stock', [
      { delayMs: 3000 },
      { delayMs: 3000 },
      { status: 200, body: { accepted: true } },
    ]);

    const warehouse = step('return { sku: "SKU-3", units: 42 };', 'warehouse reports stock');
    const storefront = callNode(externals, '/storefront/stock', { label: 'storefront' });
    const ebay = callNode(externals, '/ebay/stock', { label: 'ebay' });
    const amazon = withPolicy(
      callNode(externals, '/amazon/stock', { label: 'amazon', timeoutMs: 800 }),
      { retries: 3, backoffSeconds: 1, timeoutSeconds: 15 },
    );

    const executionId = await startRun(
      api,
      wf,
      [warehouse, storefront, ebay, amazon],
      [edge(warehouse.id, storefront.id), edge(warehouse.id, ebay.id), edge(warehouse.id, amazon.id)],
    );

    // The healthy channels finish while Amazon is still retrying.
    await until(
      api,
      executionId,
      (d) => Boolean(outcomeOf(d.logs, storefront.id)) && Boolean(outcomeOf(d.logs, ebay.id)),
      20000,
    );
    const midFlight = await until(api, executionId, () => true, 5000);
    expect(outcomeOf(midFlight.logs, storefront.id)).toBe('completed');
    expect(outcomeOf(midFlight.logs, ebay.id)).toBe('completed');

    const run = await until(api, executionId, settled, 60000);
    expect(run.meta.status).toBe('completed');
    expect(outcomeOf(run.logs, amazon.id)).toBe('completed');
    // The struggle is on the record: more attempts than the healthy channels.
    const amazonLine = run.logs.filter((l) => l.nodeId === amazon.id && l.outcome).at(-1) as
      | { attempts?: number }
      | undefined;
    expect(amazonLine?.attempts).toBeGreaterThanOrEqual(3);
    expect(externals.succeeded('/amazon/stock')).toHaveLength(1);
  }, 90000);

  it('TC03.4 two orders race for the last unit and only one reserves it', async () => {
    externals.reset();
    // The stock system is the referee: the first caller gets the unit.
    externals.script('/inventory/reserve', [
      { status: 200, body: { reserved: true } },
      { status: 200, body: { reserved: false, reason: 'out of stock' } },
    ]);

    const buildRace = (tag: string) => {
      const order = step(`return { orderId: "${tag}" };`, `order ${tag}`);
      const reserve = callNode(externals, '/inventory/reserve', { label: `reserve ${tag}` });
      reserve.data.config.body = { sku: 'SKU-LAST', orderId: tag };
      const got = branch(
        [{ id: 'yes', property: `{{${reserve.id}.data.data.reserved}}`, checkValue: true, checkOperator: 'isTrue' }],
        'reserved?',
      );
      const fulfil = callNode(externals, '/warehouse/notify', { label: `fulfil ${tag}` });
      const backorder = callNode(externals, '/email/send', { label: `backorder ${tag}` });
      backorder.data.config.body = { template: 'backorder', orderId: tag };
      return {
        nodes: [order, reserve, got, fulfil, backorder],
        edges: [
          edge(order.id, reserve.id),
          edge(reserve.id, got.id),
          { ...edge(got.id, fulfil.id), sourceHandle: 'source-yes' },
          { ...edge(got.id, backorder.id), sourceHandle: 'source-default' },
        ],
      };
    };

    const a = buildRace('race-A');
    const b = buildRace('race-B');
    const [idA, idB] = await Promise.all([
      startRun(api, wf, a.nodes, a.edges),
      startRun(api, wf, b.nodes, b.edges),
    ]);
    const [runA, runB] = await Promise.all([
      until(api, idA, settled, 40000),
      until(api, idB, settled, 40000),
    ]);

    expect(runA.meta.status).toBe('completed');
    expect(runB.meta.status).toBe('completed');
    // Exactly one order was fulfilled; the other was told, not oversold.
    expect(externals.calls('/inventory/reserve')).toHaveLength(2);
    expect(externals.calls('/warehouse/notify')).toHaveLength(1);
    const backorders = externals.calls('/email/send');
    expect(backorders).toHaveLength(1);
    const fulfilled = externals.calls('/warehouse/notify')[0];
    const backordered = backorders[0].body as { orderId?: string };
    expect(backordered.orderId).not.toBe((fulfilled.body as { orderId?: string }).orderId);
  }, 90000);

  // // cap.data is a coming-soon capability: the palette shows the upgrade
    // prompt rather than running a cloud sync. Proven in the browser pass.
  it.todo('TC03.5 a big catalogue sync prompts the data uplift (UI behaviour, browser pass)');
});
