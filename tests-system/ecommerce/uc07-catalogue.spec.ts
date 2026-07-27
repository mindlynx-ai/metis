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
 * UC07 product catalogue and feed management: publishing a product to every
 * channel, mapping categories per channel, and the nightly feed. The AI
 * description case is a paid-capability prompt (browser pass) and the image
 * hold needs both an object store and the approval queue.
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

suite('UC07 product catalogue and feed management', () => {
  const externals = new Externals();
  let api: Api;
  let wf: string;

  beforeAll(async () => {
    await externals.start();
    api = client(await login());
    const created = await api<{ workflowId: string }>('POST', '/api/workflows', {
      name: `uc07-catalogue-${Date.now()}`,
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

  it('TC07.1 a new product publishes to every channel', async () => {
    externals.reset();
    for (const path of ['/storefront/product', '/amazon/product', '/ebay/product']) {
      externals.script(path, [{ status: 200, body: { live: true } }]);
    }

    const created = step(
      'return { sku: "SKU-70", title: "Chelsea boot", images: 3, price: 129 };',
      'product created in PIM',
    );
    const channels = ['/storefront/product', '/amazon/product', '/ebay/product'].map((path) =>
      callNode(externals, path, { label: `publish ${path}` }),
    );
    for (const channel of channels) {
      channel.data.config.body = {
        sku: `{{${created.id}.data.sku}}`,
        title: `{{${created.id}.data.title}}`,
        price: `{{${created.id}.data.price}}`,
      };
    }
    const live = step('return { published: true };', 'confirm live');

    const executionId = await startRun(
      api,
      wf,
      [created, ...channels, live],
      [...channels.map((c) => edge(created.id, c.id)), ...channels.map((c) => edge(c.id, live.id))],
    );
    const run = await until(api, executionId, settled, 40000);

    expect(run.meta.status).toBe('completed');
    for (const path of ['/storefront/product', '/amazon/product', '/ebay/product']) {
      const call = externals.calls(path);
      expect(call).toHaveLength(1);
      expect((call[0].body as { sku?: string; price?: number }).sku).toBe('SKU-70');
      expect((call[0].body as { price?: number }).price).toBe(129);
    }
    expect(outcomeOf(run.logs, live.id)).toBe('completed');
  }, 60000);

  // cap.model is a coming-soon capability: the palette offers the upgrade
  // rather than silently failing. Proven in the browser pass.
  it.todo('TC07.2 an AI description offers the upgrade on the free tier (UI behaviour, browser pass)');

  // Needs the object store node for the image and the approval queue for the
  // merchandiser hold. Both are on the build list.
  it.todo('TC07.3 a low-resolution image holds the product for review (needs object store + approvals)');

  it('TC07.4 category mapping is right on every channel', async () => {
    externals.reset();
    for (const path of ['/storefront/product', '/amazon/product', '/ebay/product']) {
      externals.script(path, [{ status: 200, body: { live: true } }]);
    }

    const product = step(
      'return { sku: "SKU-74", category: "Women > Shoes > Boots" };',
      'product in internal category',
    );
    const mapper = step(
      `const internal = "{{${product.id}.data.category}}";
       const table = {
         "Women > Shoes > Boots": { amazon: "679337011", ebay: "53557", storefront: "womens-boots" },
       };
       const mapped = table[internal];
       return { amazon: mapped.amazon, ebay: mapped.ebay, storefront: mapped.storefront };`,
      'map categories',
    );
    const storefront = callNode(externals, '/storefront/product', { label: 'storefront' });
    storefront.data.config.body = { sku: 'SKU-74', category: `{{${mapper.id}.data.storefront}}` };
    const amazon = callNode(externals, '/amazon/product', { label: 'amazon' });
    amazon.data.config.body = { sku: 'SKU-74', browseNode: `{{${mapper.id}.data.amazon}}` };
    const ebay = callNode(externals, '/ebay/product', { label: 'ebay' });
    ebay.data.config.body = { sku: 'SKU-74', categoryId: `{{${mapper.id}.data.ebay}}` };

    const executionId = await startRun(
      api,
      wf,
      [product, mapper, storefront, amazon, ebay],
      [
        edge(product.id, mapper.id),
        edge(mapper.id, storefront.id),
        edge(mapper.id, amazon.id),
        edge(mapper.id, ebay.id),
      ],
    );
    const run = await until(api, executionId, settled, 40000);

    expect(run.meta.status).toBe('completed');
    expect((externals.calls('/amazon/product')[0].body as { browseNode?: string }).browseNode).toBe('679337011');
    expect((externals.calls('/ebay/product')[0].body as { categoryId?: string }).categoryId).toBe('53557');
    expect((externals.calls('/storefront/product')[0].body as { category?: string }).category).toBe(
      'womens-boots',
    );
  }, 60000);

  it('TC07.5 the nightly feed regenerates and uploads, with failures retried not lost', async () => {
    externals.reset();
    externals.script('/catalogue/export', [{ status: 200, body: { products: 1500, sizeMb: 12 } }]);
    externals.script('/feed/storefront', [{ status: 200, body: { uploaded: true } }]);
    externals.script('/feed/amazon', [{ status: 200, body: { uploaded: true } }]);
    // eBay rejects the upload, so it is queued for the morning rather than lost.
    externals.script('/feed/ebay', [{ status: 503, body: { error: 'marketplace unavailable' } }]);
    externals.script('/ops/retry-queue', [{ status: 200, body: { queued: true } }]);

    const nightly = step('return { run: "nightly" };', 'feed due');
    const exportAll = callNode(externals, '/catalogue/export', { label: 'export catalogue' });
    const sizeOk = branch(
      [
        {
          id: 'ok',
          property: `{{${exportAll.id}.data.data.sizeMb}}`,
          checkValue: 100,
          checkOperator: '<',
        },
      ],
      'within channel limits?',
    );
    const storefront = callNode(externals, '/feed/storefront', { label: 'upload storefront' });
    const amazon = callNode(externals, '/feed/amazon', { label: 'upload amazon' });
    const ebay = callNode(externals, '/feed/ebay', { label: 'upload ebay' });
    const ebayOk = branch(
      [{ id: 'ok', property: `{{${ebay.id}.data.status}}`, checkValue: 200 }],
      'ebay accepted?',
    );
    const requeue = callNode(externals, '/ops/retry-queue', { label: 'queue for the morning' });
    const oversize = step('return { halted: "feed too large" };', 'too large');

    const executionId = await startRun(
      api,
      wf,
      [nightly, exportAll, sizeOk, storefront, amazon, ebay, ebayOk, requeue, oversize],
      [
        edge(nightly.id, exportAll.id),
        edge(exportAll.id, sizeOk.id),
        { ...edge(sizeOk.id, storefront.id), sourceHandle: 'source-ok' },
        { ...edge(sizeOk.id, amazon.id), sourceHandle: 'source-ok' },
        { ...edge(sizeOk.id, ebay.id), sourceHandle: 'source-ok' },
        { ...edge(sizeOk.id, oversize.id), sourceHandle: 'source-default' },
        edge(ebay.id, ebayOk.id),
        { ...edge(ebayOk.id, requeue.id), sourceHandle: 'source-default' },
      ],
    );
    const run = await until(api, executionId, settled, 60000);

    expect(run.meta.status).toBe('completed');
    // Two channels took the feed; the third is on the retry queue, not lost.
    expect(externals.succeeded('/feed/storefront')).toHaveLength(1);
    expect(externals.succeeded('/feed/amazon')).toHaveLength(1);
    expect(externals.succeeded('/feed/ebay')).toHaveLength(0);
    const queued = externals.calls('/ops/retry-queue');
    expect(queued).toHaveLength(1);
    expect(startCount(run.logs, oversize.id)).toBe(0);
  }, 90000);
});
