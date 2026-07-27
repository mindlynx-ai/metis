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
 * UC04 abandoned cart and lifecycle journeys: the timer cases. Waits are
 * scaled down from hours to seconds; the shape (durable timer, cancel before
 * it fires, resume after a restart, escalate, expire) is identical.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, client, login, runtimeUp } from '../harness.js';
import { Externals } from './externals.js';
import {
  branch,
  callNode,
  cancelRun,
  cancelStragglers,
  detail,
  edge,
  nodeWaiting,
  outcomeOf,
  restartRuntime,
  runtimeBack,
  settled,
  startCount,
  startRun,
  step,
  until,
  wait,
  type Api,
} from './shop.js';

const up = await runtimeUp();
const suite = up ? describe : describe.skip;
if (!up) {
  // eslint-disable-next-line no-console
  console.warn(`[ecommerce] no runtime at ${BASE}; skipping. Start the stack or set METIS_URL.`);
}

suite('UC04 abandoned cart and lifecycle journeys', () => {
  const externals = new Externals();
  let api: Api;
  let wf: string;

  beforeAll(async () => {
    await externals.start();
    api = client(await login());
    const created = await api<{ workflowId: string }>('POST', '/api/workflows', {
      name: `uc04-lifecycle-${Date.now()}`,
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

  it('TC04.1 an abandoned cart waits, then the reminder goes out with the cart in it', async () => {
    externals.reset();
    externals.script('/email/send', [{ status: 200, body: { sent: true } }]);

    const abandoned = step(
      'return { cartId: "cart-1", items: ["SKU-1", "SKU-2"], total: 89.5 };',
      'cart abandoned',
    );
    const delay = wait(3, 'wait 2 hours');
    const reminder = callNode(externals, '/email/send', { label: 'reminder email' });
    reminder.data.config.body = {
      template: 'abandoned-cart',
      items: `{{${abandoned.id}.data.items}}`,
      total: `{{${abandoned.id}.data.total}}`,
      returnUrl: `https://shop.example/cart/{{${abandoned.id}.data.cartId}}`,
    };

    const startedAt = Date.now();
    const executionId = await startRun(
      api,
      wf,
      [abandoned, delay, reminder],
      [edge(abandoned.id, delay.id), edge(delay.id, reminder.id)],
    );
    const run = await until(api, executionId, settled, 40000);

    expect(run.meta.status).toBe('completed');
    const mail = externals.calls('/email/send');
    expect(mail).toHaveLength(1);
    // The email waited for the timer rather than firing immediately.
    expect(mail[0].at - startedAt).toBeGreaterThanOrEqual(2900);
    // It carries the cart, the total and a working return link.
    const body = mail[0].body as { items?: string[]; total?: number; returnUrl?: string };
    expect(body.items).toEqual(['SKU-1', 'SKU-2']);
    expect(body.total).toBe(89.5);
    expect(body.returnUrl).toBe('https://shop.example/cart/cart-1');
  }, 60000);

  it('TC04.2 the customer comes back first, so the journey cancels and no email is sent', async () => {
    externals.reset();

    const abandoned = step('return { cartId: "cart-2" };', 'cart abandoned');
    const delay = wait(20, 'wait 2 hours');
    const reminder = callNode(externals, '/email/send', { label: 'reminder email' });

    const executionId = await startRun(
      api,
      wf,
      [abandoned, delay, reminder],
      [edge(abandoned.id, delay.id), edge(delay.id, reminder.id)],
    );
    await until(api, executionId, nodeWaiting(delay.id), 20000);

    // The purchase lands: the marketing journey is cancelled.
    expect(await cancelRun(api, executionId, 'order placed')).toBe(202);
    const run = await until(api, executionId, settled, 30000);

    expect(run.meta.status).not.toBe('completed');
    expect(run.meta.status).toMatch(/cancel/i);
    // No reminder, ever: no false positive in the marketing numbers.
    expect(externals.calls('/email/send')).toHaveLength(0);
    expect(startCount(run.logs, reminder.id)).toBe(0);
  }, 60000);

  it('TC04.3 a multi-day journey resumes after a restart and keeps its original clock', async () => {
    externals.reset();
    externals.script('/email/send', [{ status: 200, body: { sent: true } }]);

    const abandoned = step('return { cartId: "cart-3" };', 'cart abandoned');
    const delay = wait(12, 'wait 24 hours');
    const second = callNode(externals, '/email/send', { label: 'day two email' });

    const startedAt = Date.now();
    const executionId = await startRun(
      api,
      wf,
      [abandoned, delay, second],
      [edge(abandoned.id, delay.id), edge(delay.id, second.id)],
    );
    await until(api, executionId, nodeWaiting(delay.id), 20000);

    await restartRuntime();
    await runtimeBack(BASE);
    api = client(await login());

    const run = await until(api, executionId, settled, 60000);
    expect(run.meta.status).toBe('completed');
    const mail = externals.calls('/email/send');
    expect(mail).toHaveLength(1);
    // The timer is anchored to the abandonment, not to the restart: the email
    // lands around the original deadline, not 12 seconds after coming back.
    const elapsed = mail[0].at - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(11000);
    expect(elapsed).toBeLessThan(30000);
  }, 180000);

  it('TC04.4 no purchase in the window escalates to a discount email', async () => {
    externals.reset();
    externals.script('/email/send', [
      { status: 200, body: { sent: true } },
      { status: 200, body: { sent: true } },
    ]);
    externals.script('/orders/status', [{ status: 200, body: { purchased: false } }]);

    const abandoned = step('return { cartId: "cart-4", discount: "SAVE10" };', 'cart abandoned');
    const firstWait = wait(2, 'wait 2 hours');
    const first = callNode(externals, '/email/send', { label: 'reminder email' });
    first.data.config.body = { template: 'abandoned-cart' };
    const secondWait = wait(2, 'wait 22 more hours');
    const purchased = callNode(externals, '/orders/status', { label: 'check purchase' });
    const didBuy = branch(
      [
        {
          id: 'bought',
          property: `{{${purchased.id}.data.data.purchased}}`,
          checkValue: true,
          checkOperator: 'isTrue',
        },
      ],
      'purchased?',
    );
    const discount = callNode(externals, '/email/send', { label: 'discount email' });
    discount.data.config.body = { template: 'discount', code: `{{${abandoned.id}.data.discount}}` };
    const done = step('return { closed: "purchased" };', 'no further contact');

    const executionId = await startRun(
      api,
      wf,
      [abandoned, firstWait, first, secondWait, purchased, didBuy, discount, done],
      [
        edge(abandoned.id, firstWait.id),
        edge(firstWait.id, first.id),
        edge(first.id, secondWait.id),
        edge(secondWait.id, purchased.id),
        edge(purchased.id, didBuy.id),
        { ...edge(didBuy.id, done.id), sourceHandle: 'source-bought' },
        { ...edge(didBuy.id, discount.id), sourceHandle: 'source-default' },
      ],
    );
    const run = await until(api, executionId, settled, 60000);

    expect(run.meta.status).toBe('completed');
    const mail = externals.calls('/email/send');
    expect(mail).toHaveLength(2);
    // The second email carries a real, single discount code.
    expect((mail[1].body as { code?: string }).code).toBe('SAVE10');
    expect(startCount(run.logs, done.id)).toBe(0);
  }, 90000);

  it('TC04.5 the journey expires cleanly with no rogue emails', async () => {
    externals.reset();
    externals.script('/email/send', [{ status: 200, body: { sent: true } }]);

    const abandoned = step('return { cartId: "cart-5" };', 'cart abandoned');
    const finalEmail = callNode(externals, '/email/send', { label: 'final email' });
    const expiry = wait(3, 'wait until day 7');
    const close = step('return { journey: "expired", removedFromActive: true };', 'close journey');

    const executionId = await startRun(
      api,
      wf,
      [abandoned, finalEmail, expiry, close],
      [edge(abandoned.id, finalEmail.id), edge(finalEmail.id, expiry.id), edge(expiry.id, close.id)],
    );
    const run = await until(api, executionId, settled, 40000);

    // Completed, not failed, and quiet after the last scheduled contact.
    expect(run.meta.status).toBe('completed');
    expect(outcomeOf(run.logs, close.id)).toBe('completed');
    expect(externals.calls('/email/send')).toHaveLength(1);
    const after = await detail(api, executionId);
    expect(after.meta.status).toBe('completed');
  }, 60000);
});
