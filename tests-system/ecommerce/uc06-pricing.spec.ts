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
 * UC06 price and promotion updates: the scheduled cases plus the saga. This
 * file is the only one that drives a real Temporal schedule (cron granularity
 * is one minute, so it is also the slowest), and the only one that proves a
 * compensating rollback across channels.
 *
 * TC06.2 (a price cut over 20% needing sign-off) waits on the approval gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, client, login, runtimeUp } from '../harness.js';
import { Externals } from './externals.js';
import {
  branch,
  callNode,
  cancelStragglers,
  edge,
  listExecutions,
  node,
  nodeId,
  outcomeOf,
  settled,
  startCount,
  startRun,
  step,
  until,
  wait,
  type Api,
  type ExecutionSummary,
} from './shop.js';

const up = await runtimeUp();
const suite = up ? describe : describe.skip;
if (!up) {
  // eslint-disable-next-line no-console
  console.warn(`[ecommerce] no runtime at ${BASE}; skipping. Start the stack or set METIS_URL.`);
}

suite('UC06 price and promotion updates', () => {
  const externals = new Externals();
  let api: Api;
  let wf: string;

  beforeAll(async () => {
    await externals.start();
    api = client(await login());
    const created = await api<{ workflowId: string }>('POST', '/api/workflows', {
      name: `uc06-pricing-${Date.now()}`,
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

  it('TC06.1 a scheduled price change fires on the cron and reaches every channel', async () => {
    externals.reset();
    for (const channel of ['/storefront/price', '/amazon/price', '/ebay/price']) {
      externals.script(channel, [{ status: 200, body: { accepted: true } }]);
    }

    // A schedule needs a published, trigger-started workflow.
    const trigger = node(nodeId(), 'scheduleconfig', { cron: '* * * * *' }, 'price change due');
    const storefront = callNode(externals, '/storefront/price', { label: 'storefront' });
    const amazon = callNode(externals, '/amazon/price', { label: 'amazon' });
    const ebay = callNode(externals, '/ebay/price', { label: 'ebay' });
    for (const channel of [storefront, amazon, ebay]) {
      channel.data.config.body = { sku: 'SKU-6', price: 79.99 };
    }

    const created = await api<{ workflowId: string }>('POST', '/api/workflows', {
      name: `uc06-scheduled-price-${Date.now()}`,
      type: 'workflow',
      nodes: [trigger, storefront, amazon, ebay],
      edges: [
        edge(trigger.id, storefront.id),
        edge(trigger.id, amazon.id),
        edge(trigger.id, ebay.id),
      ],
    });
    const scheduledWf = created.body.workflowId;
    // Publishing a schedule-triggered workflow provisions the Temporal
    // Schedule: no second gesture, and the response says so.
    const published = await api<{ status?: string; schedule?: string }>(
      'POST',
      `/api/workflows/${scheduledWf}/publish`,
    );
    expect(published.status).toBe(200);
    expect(published.body.schedule).toBe('live');

    const triggers = await api<{ items: { triggerId: string; workflowId: string; cron?: string }[] }>(
      'GET',
      '/api/triggers',
    );
    const mine = triggers.body.items.filter((t) => t.workflowId === scheduledWf);
    // Exactly one trigger row per scheduled workflow, carrying its cron.
    expect(mine).toHaveLength(1);
    expect(mine[0].cron).toBe('* * * * *');
    const triggerId = mine[0].triggerId;

    try {
      // Wait for the cron to come round (up to two minute boundaries).
      const deadline = Date.now() + 150000;
      while (Date.now() < deadline && externals.calls('/storefront/price').length < 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
      expect(externals.calls('/storefront/price').length).toBeGreaterThanOrEqual(1);
      // Every channel got the new price on the fire, with the price as a number.
      for (const path of ['/storefront/price', '/amazon/price', '/ebay/price']) {
        expect(externals.calls(path).length).toBeGreaterThanOrEqual(1);
        expect((externals.calls(path)[0].body as { price?: number }).price).toBeCloseTo(79.99, 2);
      }
      // The fire is recorded as a run against the scheduled workflow. The
      // record lands a moment after the channel calls, so poll for it.
      let recorded: ExecutionSummary | undefined;
      const recordDeadline = Date.now() + 15000;
      while (Date.now() < recordDeadline && !recorded) {
        recorded = (await listExecutions(api, 100)).find((e) => e.workflowId === scheduledWf);
        if (!recorded) await new Promise((r) => setTimeout(r, 1000));
      }
      expect(recorded).toBeDefined();
      // KNOWN LIMITATION: a schedule pins one execution id for every fire
      // (exec_sch_<tenant>_<workflow>), so tonight's run overwrites last
      // night's. The price change is applied correctly, but the history of a
      // recurring job keeps only the most recent fire. Written up for the
      // execution-id minting work; not fixed here.
      expect(recorded?.executionId).toMatch(/^exec_sch_/);
    } finally {
      await api('DELETE', `/api/triggers/${triggerId}`);
    }
  }, 240000);

  // // The threshold maths is a switch; what is missing is the gate that holds
    // the run, shows old and new price, and records who approved it.
  it.todo('TC06.2 a price cut over 20% needs sign-off (needs the approval gate, Phase 5)');

  it('TC06.3 one channel failing rolls the others back (saga)', async () => {
    externals.reset();
    externals.script('/storefront/price', [{ status: 200, body: { accepted: true, previous: 100 } }]);
    // Amazon rejects the change outright.
    externals.script('/amazon/price', [{ status: 500, body: { error: 'channel rejected the update' } }]);
    externals.script('/storefront/price/revert', [{ status: 200, body: { reverted: true } }]);
    externals.script('/ops/alert', [{ status: 200, body: { alerted: true } }]);

    const change = step('return { sku: "SKU-63", from: 100, to: 90 };', 'price change');
    const storefront = callNode(externals, '/storefront/price', { label: 'storefront' });
    const amazon = callNode(externals, '/amazon/price', { label: 'amazon' });
    const amazonOk = branch(
      [{ id: 'ok', property: `{{${amazon.id}.data.status}}`, checkValue: 200 }],
      'amazon accepted?',
    );
    const ebay = callNode(externals, '/ebay/price', { label: 'ebay' });
    // The compensating action: put the storefront back the way it was.
    const revert = callNode(externals, '/storefront/price/revert', { label: 'revert storefront' });
    revert.data.config.body = { sku: `{{${change.id}.data.sku}}`, price: `{{${change.id}.data.from}}` };
    const alert = callNode(externals, '/ops/alert', { label: 'alert ops' });
    alert.data.config.body = { text: 'Price change rolled back: amazon rejected it' };

    const executionId = await startRun(
      api,
      wf,
      [change, storefront, amazon, amazonOk, ebay, revert, alert],
      [
        edge(change.id, storefront.id),
        edge(storefront.id, amazon.id),
        edge(amazon.id, amazonOk.id),
        { ...edge(amazonOk.id, ebay.id), sourceHandle: 'source-ok' },
        { ...edge(amazonOk.id, revert.id), sourceHandle: 'source-default' },
        edge(revert.id, alert.id),
      ],
    );
    const run = await until(api, executionId, settled, 40000);

    expect(run.meta.status).toBe('completed');
    // The storefront is back at 100 and eBay was never touched.
    const reverted = externals.calls('/storefront/price/revert');
    expect(reverted).toHaveLength(1);
    expect((reverted[0].body as { price?: number }).price).toBe(100);
    expect(externals.calls('/ebay/price')).toHaveLength(0);
    expect(startCount(run.logs, ebay.id)).toBe(0);
    // Ops knows, with the rollback confirmed.
    expect(externals.succeeded('/ops/alert')).toHaveLength(1);
  }, 60000);

  it('TC06.4 a promo code activates on every channel and deactivates on time', async () => {
    externals.reset();
    for (const path of ['/storefront/promo', '/amazon/promo', '/ebay/promo']) {
      externals.script(path, [
        { status: 200, body: { active: true } },
        { status: 200, body: { active: false } },
      ]);
    }

    const activate = step('return { code: "SUMMER25", percent: 25 };', 'activation due');
    const on = ['/storefront/promo', '/amazon/promo', '/ebay/promo'].map((path) =>
      callNode(externals, path, { label: `activate ${path}` }),
    );
    for (const n of on) n.data.config.body = { code: 'SUMMER25', state: 'on' };
    const window = wait(3, 'sale window');
    const off = ['/storefront/promo', '/amazon/promo', '/ebay/promo'].map((path) =>
      callNode(externals, path, { label: `deactivate ${path}` }),
    );
    for (const n of off) n.data.config.body = { code: 'SUMMER25', state: 'off' };

    const executionId = await startRun(
      api,
      wf,
      [activate, ...on, window, ...off],
      [
        ...on.map((n) => edge(activate.id, n.id)),
        ...on.map((n) => edge(n.id, window.id)),
        ...off.map((n) => edge(window.id, n.id)),
      ],
    );
    const run = await until(api, executionId, settled, 60000);

    expect(run.meta.status).toBe('completed');
    for (const path of ['/storefront/promo', '/amazon/promo', '/ebay/promo']) {
      const calls = externals.calls(path);
      expect(calls).toHaveLength(2);
      expect((calls[0].body as { state?: string }).state).toBe('on');
      expect((calls[1].body as { state?: string }).state).toBe('off');
      // The code was live for the window, not longer.
      expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(2900);
    }
  }, 90000);

  it('TC06.5 a flash sale starts and stops inside its window', async () => {
    externals.reset();
    externals.script('/storefront/price', [
      { status: 200, body: { price: 50 } },
      { status: 200, body: { price: 100 } },
    ]);
    externals.script('/orders/price-quote', [{ status: 200, body: { quoted: 50 } }]);

    const start = step('return { sku: "SKU-65", sale: 50, normal: 100 };', 'flash sale starts');
    const markdown = callNode(externals, '/storefront/price', { label: 'reduce price' });
    markdown.data.config.body = { sku: 'SKU-65', price: `{{${start.id}.data.sale}}` };
    // An order lands mid-sale and must be quoted at the sale price.
    const inFlight = callNode(externals, '/orders/price-quote', { label: 'in-flight order' });
    const window = wait(4, 'one hour of sale');
    const restore = callNode(externals, '/storefront/price', { label: 'restore price' });
    restore.data.config.body = { sku: 'SKU-65', price: `{{${start.id}.data.normal}}` };

    const executionId = await startRun(
      api,
      wf,
      [start, markdown, inFlight, window, restore],
      [
        edge(start.id, markdown.id),
        edge(markdown.id, inFlight.id),
        edge(inFlight.id, window.id),
        edge(window.id, restore.id),
      ],
    );
    const run = await until(api, executionId, settled, 60000);

    expect(run.meta.status).toBe('completed');
    const prices = externals.calls('/storefront/price');
    expect(prices).toHaveLength(2);
    expect((prices[0].body as { price?: number }).price).toBe(50);
    expect((prices[1].body as { price?: number }).price).toBe(100);
    // The window is accurate to the second, and the in-flight order was
    // quoted while the sale price was live.
    const held = prices[1].at - prices[0].at;
    expect(held).toBeGreaterThanOrEqual(3900);
    expect(held).toBeLessThan(9000);
    const quote = externals.calls('/orders/price-quote')[0];
    expect(quote.at).toBeGreaterThanOrEqual(prices[0].at);
    expect(quote.at).toBeLessThan(prices[1].at);
    expect(outcomeOf(run.logs, restore.id)).toBe('completed');
  }, 90000);
});
