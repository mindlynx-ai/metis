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
 * UC02 payment and refund flows. The money cases: a full refund end to end,
 * a payment provider that stops answering, a partial refund on a multi-item
 * order, and the one that matters most - a later step failing must never
 * reissue the refund.
 *
 * TC02.2 (high-value refund needs approval) waits on the approval gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, client, login, runtimeUp } from '../harness.js';
import { Externals } from './externals.js';
import {
  callNode,
  cancelStragglers,
  edge,
  outcomeOf,
  settled,
  startCount,
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

suite('UC02 payment and refund flows', () => {
  const externals = new Externals();
  let api: Api;
  let wf: string;

  beforeAll(async () => {
    await externals.start();
    api = client(await login());
    const created = await api<{ workflowId: string }>('POST', '/api/workflows', {
      name: `uc02-payments-${Date.now()}`,
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

  it('TC02.1 a full refund completes and the customer is told', async () => {
    externals.reset();
    externals.script('/orders/get', [
      { status: 200, body: { orderId: 'ord-100', total: 150, state: 'fulfilled' } },
    ]);
    externals.script('/psp/refund', [{ status: 200, body: { refundId: 'ref_abc123', amount: 150 } }]);

    const request = step('return { orderId: "ord-100", reason: "changed mind" };', 'refund requested');
    const order = callNode(externals, '/orders/get', { label: 'validate order' });
    const eligible = step('return { eligible: true, amount: 150 };', 'eligibility check');
    const refund = callNode(externals, '/psp/refund', {
      label: 'issue refund',
      body: { orderId: 'ord-100', amount: 150 },
    });
    const email = callNode(externals, '/email/send', { label: 'refund confirmation' });
    email.data.config.body = {
      template: 'refunded',
      refundId: `{{${refund.id}.data.data.refundId}}`,
    };
    const chain = [request, order, eligible, refund, email];

    const executionId = await startRun(
      api,
      wf,
      chain,
      chain.slice(0, -1).map((n, i) => edge(n.id, chain[i + 1].id)),
    );
    const run = await until(api, executionId, settled, 40000);

    expect(run.meta.status).toBe('completed');
    // The refund matches the original order total, issued once.
    const issued = externals.calls('/psp/refund');
    expect(issued).toHaveLength(1);
    expect((issued[0].body as { amount?: number }).amount).toBe(150);
    // The PSP confirmation id reaches both the customer and the run record.
    const mail = externals.calls('/email/send');
    expect(mail).toHaveLength(1);
    expect((mail[0].body as { refundId?: string }).refundId).toBe('ref_abc123');
    expect(JSON.stringify(run.logs)).toMatch(/ref_abc123/);
    // "Completed within 60s" from the spec.
    const started = Date.parse(run.meta.startedAt ?? '');
    const ended = Date.parse(run.meta.endedAt ?? '');
    if (!Number.isNaN(started) && !Number.isNaN(ended)) {
      expect(ended - started).toBeLessThan(60000);
    }
  }, 60000);

  // // Blocked on cap.approvals: nothing parks a run for a human decision, and
    // there is no queue where an approver sees the order, amount and reason.
  it.todo('TC02.2 high-value refund requires approval (needs the approval gate, Phase 5)');

  it('TC02.3 the payment provider stops answering and the retry policy gives up cleanly', async () => {
    externals.reset();
    externals.script('/psp/refund', [{ delayMs: 4000 }, { delayMs: 4000 }, { delayMs: 4000 }]);

    const request = step('return { orderId: "ord-103", amount: 90 };', 'refund requested');
    const refund = withPolicy(
      callNode(externals, '/psp/refund', {
        label: 'issue refund',
        timeoutMs: 1200,
        body: { orderId: 'ord-103', amount: 90 },
      }),
      { retries: 3, backoffSeconds: 1, timeoutSeconds: 10 },
    );
    const ledger = callNode(externals, '/ledger/post', { label: 'post to ledger' });

    const executionId = await startRun(
      api,
      wf,
      [request, refund, ledger],
      [edge(request.id, refund.id), edge(refund.id, ledger.id)],
    );
    const run = await until(api, executionId, settled, 60000);

    expect(run.meta.status).toBe('failed');
    expect(outcomeOf(run.logs, refund.id)).toBe('failed');
    // Attempts are visible in run history, with a legible reason. `retries: 3`
    // means three retries after the first try, so four attempts in total.
    const line = run.logs.filter((l) => l.nodeId === refund.id && l.outcome).at(-1) as
      | { attempts?: number; error?: unknown }
      | undefined;
    expect(line?.attempts).toBe(4);
    expect(JSON.stringify(line?.error ?? '')).toMatch(/abort|timeout|terminated|operation/i);
    // No funds moved and nothing downstream ran.
    expect(externals.succeeded('/psp/refund')).toHaveLength(0);
    expect(startCount(run.logs, ledger.id)).toBe(0);
  }, 90000);

  it('TC02.4 a partial refund pays back one item, not the order', async () => {
    externals.reset();
    externals.script('/orders/get', [
      {
        status: 200,
        body: {
          orderId: 'ord-104',
          total: 300,
          items: [
            { sku: 'A', price: 75 },
            { sku: 'B', price: 150 },
            { sku: 'C', price: 75 },
          ],
        },
      },
    ]);
    externals.script('/psp/refund', [{ status: 200, body: { refundId: 'ref_partial', amount: 75 } }]);

    const request = step('return { orderId: "ord-104", sku: "A" };', 'refund requested');
    const order = callNode(externals, '/orders/get', { label: 'load order' });
    const amount = step(
      `const items = {{${order.id}.data.data.items}};
       const line = items.find((i) => i.sku === "A");
       return { sku: line.sku, amount: line.price, orderTotal: 300 };`,
      'calculate refund',
    );
    const refund = callNode(externals, '/psp/refund', { label: 'issue refund' });
    refund.data.config.body = {
      orderId: 'ord-104',
      amount: `{{${amount.id}.data.amount}}`,
      sku: `{{${amount.id}.data.sku}}`,
    };
    const email = callNode(externals, '/email/send', { label: 'partial refund email' });
    email.data.config.body = { template: 'partial-refund', sku: `{{${amount.id}.data.sku}}` };

    const chain = [request, order, amount, refund, email];
    const executionId = await startRun(
      api,
      wf,
      chain,
      chain.slice(0, -1).map((n, i) => edge(n.id, chain[i + 1].id)),
    );
    const run = await until(api, executionId, settled, 40000);

    expect(run.meta.status).toBe('completed');
    const issued = externals.calls('/psp/refund')[0].body as { amount?: number; sku?: string };
    expect(issued.amount).toBe(75);
    expect(issued.amount).not.toBe(300);
    // The customer is told which item was refunded.
    expect((externals.calls('/email/send')[0].body as { sku?: string }).sku).toBe('A');
  }, 60000);

  it('TC02.5 a failing notification retries alone: the refund is never reissued', async () => {
    externals.reset();
    externals.script('/psp/refund', [{ status: 200, body: { refundId: 'ref_once' } }]);
    // The mail service hangs twice, then comes back. A hang (not a 5xx) is
    // what actually fails an http node, so the retry policy has something to
    // work with; a 5xx completes the node with the status as data.
    externals.script('/email/send', [{ delayMs: 3000 }, { delayMs: 3000 }, { status: 200, body: { sent: true } }]);

    const request = step('return { orderId: "ord-105" };', 'refund requested');
    const refund = callNode(externals, '/psp/refund', { label: 'issue refund' });
    const email = withPolicy(
      callNode(externals, '/email/send', { label: 'refund confirmation', timeoutMs: 800 }),
      { retries: 3, backoffSeconds: 1, timeoutSeconds: 10 },
    );

    const executionId = await startRun(
      api,
      wf,
      [request, refund, email],
      [edge(request.id, refund.id), edge(refund.id, email.id)],
    );
    const run = await until(api, executionId, settled, 60000);

    expect(run.meta.status).toBe('completed');
    // Only the mail step retried. The money moved exactly once.
    expect(externals.succeeded('/psp/refund')).toHaveLength(1);
    expect(startCount(run.logs, refund.id)).toBe(1);
    expect(externals.succeeded('/email/send')).toHaveLength(1);
    const mailLine = run.logs.filter((l) => l.nodeId === email.id && l.outcome).at(-1) as
      | { attempts?: number }
      | undefined;
    expect(mailLine?.attempts).toBe(3);
  }, 90000);
});
