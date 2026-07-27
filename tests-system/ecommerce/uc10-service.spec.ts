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
 * UC10 customer service automations: getting ahead of a late delivery, VIP
 * alerts to the service desk, review requests that respect an opt-out, and
 * multi-language templates. The compensation case needs the approval gate for
 * anything above the policy limit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, client, login, runtimeUp } from '../harness.js';
import { Externals } from './externals.js';
import {
  branch,
  callNode,
  cancelStragglers,
  edge,
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

suite('UC10 customer service automations', () => {
  const externals = new Externals();
  let api: Api;
  let wf: string;

  beforeAll(async () => {
    await externals.start();
    api = client(await login());
    const created = await api<{ workflowId: string }>('POST', '/api/workflows', {
      name: `uc10-service-${Date.now()}`,
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

  it('TC10.1 a late delivery is apologised for before the customer complains', async () => {
    externals.reset();
    externals.script('/orders/undelivered', [
      { status: 200, body: { orders: [{ orderId: 'ord-1001', daysLate: 2 }] } },
    ]);
    externals.script('/email/send', [{ status: 200, body: { sent: true } }]);
    externals.script('/cs/ticket', [{ status: 200, body: { ticketId: 'CS-77' } }]);

    const daily = step('return { check: "undelivered orders" };', 'daily check');
    const overdue = callNode(externals, '/orders/undelivered', { label: 'find overdue orders' });
    const late = branch(
      [
        {
          id: 'late',
          property: `{{${overdue.id}.data.data.orders.0.daysLate}}`,
          checkValue: 1,
          checkOperator: '>',
        },
      ],
      'overdue?',
    );
    const apology = callNode(externals, '/email/send', { label: 'apology and discount' });
    apology.data.config.body = { template: 'delivery-delay', discount: 15, orderId: 'ord-1001' };
    const ticket = callNode(externals, '/cs/ticket', { label: 'raise CS ticket' });
    ticket.data.config.body = { orderId: 'ord-1001', reason: 'delivery delay', automated: true };
    const noop = step('return { onTime: true };', 'nothing to do');

    const executionId = await startRun(
      api,
      wf,
      [daily, overdue, late, apology, ticket, noop],
      [
        edge(daily.id, overdue.id),
        edge(overdue.id, late.id),
        { ...edge(late.id, apology.id), sourceHandle: 'source-late' },
        edge(apology.id, ticket.id),
        { ...edge(late.id, noop.id), sourceHandle: 'source-default' },
      ],
    );
    const run = await until(api, executionId, settled, 40000);

    expect(run.meta.status).toBe('completed');
    // The discount stays inside policy, and CS has the context.
    const mail = externals.calls('/email/send');
    expect(mail).toHaveLength(1);
    expect((mail[0].body as { discount?: number }).discount).toBeLessThanOrEqual(20);
    const raised = externals.calls('/cs/ticket');
    expect(raised).toHaveLength(1);
    expect((raised[0].body as { automated?: boolean }).automated).toBe(true);
    expect(startCount(run.logs, noop.id)).toBe(0);
  }, 60000);

  it('TC10.2 a VIP order alerts the service desk, and only a VIP does', async () => {
    externals.reset();
    externals.script('/slack/chat.postMessage', [{ status: 200, body: { ok: true } }]);

    const buildOrder = (tier: string) => {
      const placed = step(`return { orderId: "ord-${tier}", tier: "${tier}", value: 450 };`, `${tier} order`);
      const isVip = branch(
        [{ id: 'vip', property: `{{${placed.id}.data.tier}}`, checkValue: 'vip' }],
        'VIP?',
      );
      const alert = callNode(externals, '/slack/chat.postMessage', { label: 'alert #vip-orders' });
      alert.data.config.body = {
        channel: '#vip-orders',
        text: `VIP order ${tier}`,
        orderValue: `{{${placed.id}.data.value}}`,
      };
      const quiet = step('return { alerted: false };', 'no alert');
      return {
        nodes: [placed, isVip, alert, quiet],
        edges: [
          edge(placed.id, isVip.id),
          { ...edge(isVip.id, alert.id), sourceHandle: 'source-vip' },
          { ...edge(isVip.id, quiet.id), sourceHandle: 'source-default' },
        ],
        alert,
      };
    };

    const vip = buildOrder('vip');
    const standard = buildOrder('standard');
    const vipRun = await startRun(api, wf, vip.nodes, vip.edges);
    const standardRun = await startRun(api, wf, standard.nodes, standard.edges);
    const [a, b] = await Promise.all([
      until(api, vipRun, settled, 40000),
      until(api, standardRun, settled, 40000),
    ]);

    expect(a.meta.status).toBe('completed');
    expect(b.meta.status).toBe('completed');
    // Exactly one alert, for the VIP, carrying actionable detail.
    const alerts = externals.calls('/slack/chat.postMessage');
    expect(alerts).toHaveLength(1);
    expect((alerts[0].body as { text?: string }).text).toMatch(/vip/i);
    expect((alerts[0].body as { orderValue?: number }).orderValue).toBe(450);
    expect(startCount(b.logs, standard.alert.id)).toBe(0);
  }, 90000);

  it('TC10.3 a review request waits, then respects a late opt-out', async () => {
    externals.reset();
    externals.script('/crm/consent', [{ status: 200, body: { optedIn: false } }]);

    const delivered = step('return { orderId: "ord-1003" };', 'delivery confirmed');
    const window = wait(3, 'wait 7 days');
    const consent = callNode(externals, '/crm/consent', { label: 're-check opt-in' });
    const stillIn = branch(
      [
        {
          id: 'in',
          property: `{{${consent.id}.data.data.optedIn}}`,
          checkValue: true,
          checkOperator: 'isTrue',
        },
      ],
      'still opted in?',
    );
    const request = callNode(externals, '/email/send', { label: 'review request' });
    const suppressed = step('return { suppressed: "opted out during the wait" };', 'suppress');

    const executionId = await startRun(
      api,
      wf,
      [delivered, window, consent, stillIn, request, suppressed],
      [
        edge(delivered.id, window.id),
        edge(window.id, consent.id),
        edge(consent.id, stillIn.id),
        { ...edge(stillIn.id, request.id), sourceHandle: 'source-in' },
        { ...edge(stillIn.id, suppressed.id), sourceHandle: 'source-default' },
      ],
    );
    const run = await until(api, executionId, settled, 40000);

    expect(run.meta.status).toBe('completed');
    // The consent check happened after the wait, and the email was suppressed.
    expect(externals.calls('/crm/consent')).toHaveLength(1);
    expect(externals.calls('/email/send')).toHaveLength(0);
    expect(startCount(run.logs, request.id)).toBe(0);
    expect(startCount(run.logs, suppressed.id)).toBe(1);
  }, 60000);

  // The under-limit half is ordinary branching; anything above the policy
  // limit must pause for a human, which is the approval gate.
  it.todo('TC10.4 compensation above the policy limit pauses for approval (needs the approval gate, Phase 5)');

  it('TC10.5 a French customer gets the French template, with a safe fallback', async () => {
    externals.reset();
    externals.script('/email/send', [
      { status: 200, body: { sent: true } },
      { status: 200, body: { sent: true } },
    ]);

    const buildSend = (locale: string) => {
      const customer = step(`return { locale: "${locale}", total: 1234.5 };`, `${locale} customer`);
      const pick = step(
        `const locale = "{{${customer.id}.data.locale}}";
         const templates = { "en-GB": "receipt-en", "fr-FR": "receipt-fr" };
         const chosen = templates[locale] ?? templates["en-GB"];
         const currency = locale === "fr-FR" ? "EUR" : "GBP";
         return { template: chosen, currency, fellBack: !templates[locale] };`,
        'choose template',
      );
      const send = callNode(externals, '/email/send', { label: `send ${locale}` });
      send.data.config.body = {
        template: `{{${pick.id}.data.template}}`,
        currency: `{{${pick.id}.data.currency}}`,
        fellBack: `{{${pick.id}.data.fellBack}}`,
      };
      return { nodes: [customer, pick, send], edges: [edge(customer.id, pick.id), edge(pick.id, send.id)] };
    };

    const french = buildSend('fr-FR');
    const missing = buildSend('de-DE');
    const frenchRun = await startRun(api, wf, french.nodes, french.edges);
    await until(api, frenchRun, settled, 40000);
    const missingRun = await startRun(api, wf, missing.nodes, missing.edges);
    await until(api, missingRun, settled, 40000);

    const sent = externals.calls('/email/send');
    expect(sent).toHaveLength(2);
    // French first time, no fallback, and the currency follows the locale.
    const fr = sent[0].body as { template?: string; currency?: string; fellBack?: boolean };
    expect(fr.template).toBe('receipt-fr');
    expect(fr.currency).toBe('EUR');
    expect(fr.fellBack).toBe(false);
    // A locale with no template falls back to English instead of failing.
    const de = sent[1].body as { template?: string; fellBack?: boolean };
    expect(de.template).toBe('receipt-en');
    expect(de.fellBack).toBe(true);
  }, 90000);
});
