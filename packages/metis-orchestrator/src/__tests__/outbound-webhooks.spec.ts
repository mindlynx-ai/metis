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
import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LocalEventBus, type WorkflowEvent } from '@mindlynx/metis-ports';
import { DataGateway, MemoryAdapter } from '@mindlynx/metis-data-gateway';
import {
  OutboundWebhookService,
  registerOutboundWebhookTable,
  signOutbound,
  outboundHeaders,
  matchesEvent,
  type DeliverFn,
  type OutboundWebhookRecord,
} from '../outbound-webhooks.js';
import { verifyTriggerSignature } from '../webhook-ingress.js';

const event = (over: Partial<WorkflowEvent> = {}): WorkflowEvent => ({
  name: 'workflow.execution.completed',
  tenantId: 't1',
  executionId: 'exec_1',
  workflowId: 'wf',
  timestamp: '2026-07-04T00:00:00Z',
  payload: { status: 'completed' },
  ...over,
});

function service(options = {}) {
  const gateway = new DataGateway(new MemoryAdapter());
  registerOutboundWebhookTable(gateway);
  return new OutboundWebhookService(gateway, 't1', options);
}

describe('outbound webhook signing and matching', () => {
  it('signs a body so the inbound generic HMAC verifier accepts it (symmetry)', () => {
    const body = '{"id":"d1","event":"workflow.execution.completed"}';
    const headers = outboundHeaders({ secret: 'shared' }, body, { deliveryId: 'd1', event: 'x', timestamp: 't' });
    expect(headers['x-metis-signature']).toBe(signOutbound('shared', body));
    expect(verifyTriggerSignature({ verification: 'hmac', secret: 'shared' }, body, headers)).toBe(true);
    expect(verifyTriggerSignature({ verification: 'hmac', secret: 'wrong' }, body, headers)).toBe(false);
  });

  it('omits the signature header when there is no secret', () => {
    const headers = outboundHeaders({}, '{}', { deliveryId: 'd', event: 'e', timestamp: 't' });
    expect(headers['x-metis-signature']).toBeUndefined();
  });

  it('matches by event name, wildcard and workflow filter', () => {
    const base: OutboundWebhookRecord = { webhookId: 'w', tenantId: 't1', url: 'https://x', events: ['workflow.execution.completed'], enabled: true };
    expect(matchesEvent(base, event())).toBe(true);
    expect(matchesEvent(base, event({ name: 'workflow.node.started' }))).toBe(false);
    expect(matchesEvent({ ...base, events: ['*'] }, event({ name: 'workflow.node.started' }))).toBe(true);
    expect(matchesEvent({ ...base, workflowId: 'other' }, event())).toBe(false);
    expect(matchesEvent({ ...base, enabled: false }, event())).toBe(false);
  });
});

describe('OutboundWebhookService delivery', () => {
  it('delivers a signed POST to a matching subscription', async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const deliver: DeliverFn = async (url, body, headers) => {
      calls.push({ url, body, headers });
      return { status: 200 };
    };
    const svc = service({ deliver, idFactory: () => 'del_1' });
    await svc.register({ url: 'https://hook.test/in', events: ['workflow.execution.completed'], secret: 'k' });
    const results = await svc.dispatch(event());
    expect(results[0].delivered).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://hook.test/in');
    const payload = JSON.parse(calls[0].body) as { event: string; data: { status: string }; id: string };
    expect(payload.event).toBe('workflow.execution.completed');
    expect(payload.data.status).toBe('completed');
    expect(calls[0].headers['x-metis-delivery']).toBe('del_1');
    expect(verifyTriggerSignature({ verification: 'hmac', secret: 'k' }, calls[0].body, calls[0].headers)).toBe(true);
  });

  it('retries on failure with backoff then gives up', async () => {
    let attempts = 0;
    const slept: number[] = [];
    const deliver: DeliverFn = async () => {
      attempts += 1;
      return { status: 500 };
    };
    const svc = service({ deliver, sleep: async (ms: number) => { slept.push(ms); }, maxAttempts: 3, backoffMs: 100 });
    await svc.register({ url: 'https://down.test', events: ['*'] });
    const [result] = await svc.dispatch(event());
    expect(attempts).toBe(3);
    expect(slept).toEqual([100, 200]);
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/status 500/);
  });

  it('recovers on a later attempt', async () => {
    let attempts = 0;
    const deliver: DeliverFn = async () => {
      attempts += 1;
      return { status: attempts < 2 ? 503 : 202 };
    };
    const svc = service({ deliver, sleep: async () => undefined });
    await svc.register({ url: 'https://flaky.test', events: ['*'] });
    const [result] = await svc.dispatch(event());
    expect(result.delivered).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('skips disabled subscriptions and other tenants', async () => {
    const calls: string[] = [];
    const deliver: DeliverFn = async (url) => {
      calls.push(url);
      return { status: 200 };
    };
    const svc = service({ deliver });
    const w = await svc.register({ url: 'https://a.test', events: ['*'] });
    await svc.setEnabled(w.webhookId, false);
    expect(await svc.dispatch(event())).toEqual([]);
    expect(await svc.dispatch(event({ tenantId: 't2' }))).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('OutboundWebhookService over the bus and a real HTTP endpoint', () => {
  it('POSTs a verifiable signed body when a lifecycle event fires', async () => {
    const received: { body: string; headers: Record<string, string | string[] | undefined> }[] = [];
    const server: Server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        received.push({ body: raw, headers: req.headers });
        res.statusCode = 200;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;

    const deliver: DeliverFn = async (target, body, headers) => {
      const response = await fetch(target, { method: 'POST', body, headers });
      return { status: response.status };
    };
    const bus = new LocalEventBus();
    const svc = service({ deliver });
    await svc.register({ url, events: ['*'], secret: 'shared' });
    svc.init(bus);

    bus.emit(event({ name: 'workflow.execution.completed' }));
    for (let attempt = 0; attempt < 100 && received.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    svc.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(received).toHaveLength(1);
    const payload = JSON.parse(received[0].body) as { event: string };
    expect(payload.event).toBe('workflow.execution.completed');
    expect(verifyTriggerSignature({ verification: 'hmac', secret: 'shared' }, received[0].body, received[0].headers)).toBe(true);
  });
});
