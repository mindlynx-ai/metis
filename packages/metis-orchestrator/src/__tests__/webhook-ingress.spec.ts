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
import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionPort, StartExecutionRequest } from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { TriggerService, registerTriggerTable, type TriggerRecord } from '../triggers.js';
import {
  handleWebhook,
  verifyTriggerSignature,
  normaliseEnvelope,
  type WebhookEnvelope,
} from '../webhook-ingress.js';

class FakeExecutions implements ExecutionPort {
  started: (StartExecutionRequest & Record<string, unknown>)[] = [];
  async start(request: StartExecutionRequest & Record<string, unknown>) {
    this.started.push(request);
    return { executionId: request.executionId };
  }
  async signal() {}
  async cancel() {}
  async queryStatus() {
    return 'running' as const;
  }
  async describe() {
    return {};
  }
}

const githubSig = (body: string, secret: string) =>
  `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
const hmacSig = (body: string, secret: string) =>
  createHmac('sha256', secret).update(body, 'utf8').digest('base64');

describe('webhook signature verification', () => {
  const body = '{"hello":"world"}';
  it('accepts a valid GitHub signature and rejects a bad one', () => {
    const trg = { verification: 'github' as const, secret: 'sec' };
    expect(verifyTriggerSignature(trg, body, { 'x-hub-signature-256': githubSig(body, 'sec') })).toBe(true);
    expect(verifyTriggerSignature(trg, body, { 'x-hub-signature-256': githubSig(body, 'wrong') })).toBe(false);
  });
  it('accepts a valid generic HMAC and rejects a missing secret', () => {
    expect(
      verifyTriggerSignature({ verification: 'hmac', secret: 'k' }, body, { 'x-metis-signature': hmacSig(body, 'k') }),
    ).toBe(true);
    expect(verifyTriggerSignature({ verification: 'hmac', secret: '' }, body, {})).toBe(false);
  });
  it('passes through when verification is none', () => {
    expect(verifyTriggerSignature({ verification: 'none' }, body, {})).toBe(true);
  });
});

describe('envelope normalisation', () => {
  it('lifts GitHub event + delivery headers', () => {
    const trg = { triggerId: 't', connectorId: 'github', event: 'push' } as TriggerRecord;
    const env = normaliseEnvelope(trg, { 'x-github-event': 'issues', 'x-github-delivery': 'd-1' }, { a: 1 }, '2026-07-04T00:00:00Z');
    expect(env.event).toBe('issues');
    expect(env.deliveryId).toBe('d-1');
    expect(env.body).toEqual({ a: 1 });
  });
});

describe('handleWebhook', () => {
  let store: WorkflowStore;
  let triggers: TriggerService;
  let executions: FakeExecutions;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-webhook-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'wh.db')));
    registerWorkflowTables(gateway);
    registerTriggerTable(gateway);
    store = new WorkflowStore(gateway);
    triggers = new TriggerService(gateway, 't1');
    executions = new FakeExecutions();
    await store.putWorkflowVersion({
      tenantId: 't1',
      workflowId: 'wf',
      version: 1,
      changeset: 0,
      status: 'published',
      name: 'wf',
      type: 'workflow',
      definition: { nodes: [{ id: 'n', type: 'code', config: { code: 'return {}' } }], edges: [] },
    });
  });

  const deps = () => ({
    triggers,
    store,
    executions,
    tenantId: 't1',
    newExecutionId: () => 'exec_fixed',
    now: () => '2026-07-04T00:00:00Z',
  });

  it('starts the bound workflow on a signed webhook, binding the envelope', async () => {
    const trg = await triggers.create({ kind: 'webhook', workflowId: 'wf', connectorId: 'github', event: 'push', verification: 'github', secret: 'sec' });
    const raw = '{"ref":"refs/heads/main"}';
    const result = await handleWebhook(deps(), { triggerId: trg.triggerId, rawBody: raw, headers: { 'x-hub-signature-256': githubSig(raw, 'sec'), 'x-github-event': 'push' } });
    expect(result).toEqual({ status: 202, executionId: 'exec_fixed' });
    expect(executions.started).toHaveLength(1);
    const input = executions.started[0].input as unknown as WebhookEnvelope;
    expect(input.connectorId).toBe('github');
    expect(input.event).toBe('push');
    expect(input.body).toEqual({ ref: 'refs/heads/main' });
  });

  it('404s an unknown or disabled trigger', async () => {
    expect((await handleWebhook(deps(), { triggerId: 'nope', rawBody: '{}', headers: {} })).status).toBe(404);
    const trg = await triggers.create({ kind: 'webhook', workflowId: 'wf', verification: 'none' });
    await triggers.setEnabled(trg.triggerId, false);
    expect((await handleWebhook(deps(), { triggerId: trg.triggerId, rawBody: '{}', headers: {} })).status).toBe(404);
  });

  it('401s a bad signature and 400s a non-JSON body', async () => {
    const signed = await triggers.create({ kind: 'webhook', workflowId: 'wf', verification: 'github', secret: 'sec' });
    expect((await handleWebhook(deps(), { triggerId: signed.triggerId, rawBody: '{}', headers: { 'x-hub-signature-256': 'sha256=bad' } })).status).toBe(401);
    const open = await triggers.create({ kind: 'webhook', workflowId: 'wf', verification: 'none' });
    expect((await handleWebhook(deps(), { triggerId: open.triggerId, rawBody: 'not-json', headers: {} })).status).toBe(400);
  });

  it('404s when the bound workflow has no published version', async () => {
    const trg = await triggers.create({ kind: 'webhook', workflowId: 'missing', verification: 'none' });
    const result = await handleWebhook(deps(), { triggerId: trg.triggerId, rawBody: '{}', headers: {} });
    expect(result.status).toBe(404);
    expect(result.error).toMatch(/no published version/);
  });
});
