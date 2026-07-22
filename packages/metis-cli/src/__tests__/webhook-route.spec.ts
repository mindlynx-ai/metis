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
import Fastify, { type FastifyInstance } from 'fastify';
import type { ExecutionPort, StartExecutionRequest } from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { TriggerService, registerTriggerTable } from '@mindlynx/metis-orchestrator';
import { registerWebhookRoute } from '../control-server.js';

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

describe('POST /hooks/:triggerId route', () => {
  let app: FastifyInstance;
  let triggers: TriggerService;
  let executions: FakeExecutions;
  let triggerId: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-hookroute-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'hook.db')));
    registerWorkflowTables(gateway);
    registerTriggerTable(gateway);
    const store = new WorkflowStore(gateway);
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
    const created = await triggers.create({ kind: 'webhook', workflowId: 'wf', connectorId: 'github', verification: 'github', secret: 'sec' });
    triggerId = created.triggerId;

    app = Fastify({ logger: false });
    // A JSON route on the same app proves the raw-body parser stays scoped.
    app.post('/api/echo', async (request) => request.body);
    await registerWebhookRoute(app, {
      triggers,
      store,
      executions,
      tenantId: 't1',
      newExecutionId: () => 'exec_fixed',
      now: () => '2026-07-04T00:00:00Z',
    });
    await app.ready();
  });

  it('accepts a signed GitHub delivery and starts the workflow', async () => {
    const body = '{"ref":"refs/heads/main"}';
    const signature = `sha256=${createHmac('sha256', 'sec').update(body, 'utf8').digest('hex')}`;
    const response = await app.inject({
      method: 'POST',
      url: `/hooks/${triggerId}`,
      headers: { 'x-hub-signature-256': signature, 'x-github-event': 'push', 'content-type': 'application/json' },
      payload: body,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ executionId: 'exec_fixed' });
    expect(executions.started).toHaveLength(1);
    const input = executions.started[0].input as { body: { ref: string }; event: string };
    expect(input.body.ref).toBe('refs/heads/main');
    expect(input.event).toBe('push');
  });

  it('rejects a bad signature with 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/hooks/${triggerId}`,
      headers: { 'x-hub-signature-256': 'sha256=deadbeef', 'content-type': 'application/json' },
      payload: '{"ref":"x"}',
    });
    expect(response.statusCode).toBe(401);
    expect(executions.started).toHaveLength(0);
  });

  it('404s an unknown trigger id', async () => {
    const response = await app.inject({ method: 'POST', url: '/hooks/trg_nope', payload: '{}' });
    expect(response.statusCode).toBe(404);
  });

  it('keeps JSON parsing working on other routes', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/echo', payload: { a: 1 } });
    expect(response.json()).toEqual({ a: 1 });
  });
});
