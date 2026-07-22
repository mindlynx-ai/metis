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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { FastifyInstance } from 'fastify';
import {
  CapturingEventSink,
  FakeCredentialPort,
  NodeHandlerRegistry,
  SingleTenantIdentity,
} from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { createActivities } from '@mindlynx/metis-engine';
import { buildServer } from './server-harness.js';
import { TemporalExecutionAdapter } from '../temporal-execution-adapter.js';
import { ScheduleService } from '../schedules.js';

const TASK_QUEUE = 'metis-triggers-spec';
const HOOK = 'node-a1aaaaaa-1111-4222-8333-444444444444';
const RECORD = 'node-a2bbbbbb-1111-4222-8333-444444444444';
const WEBHOOK_SECRET = 'hook-secret-1';

describe('trigger ingress: webhooks and schedules', () => {
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;
  let app: FastifyInstance;
  let store: WorkflowStore;
  let token: string;
  const recordedConfigs: Record<string, unknown>[] = [];

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createLocal();
    const dir = mkdtempSync(join(tmpdir(), 'metis-triggers-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'triggers.db')));
    registerWorkflowTables(gateway);
    store = new WorkflowStore(gateway);
    const nodes = new NodeHandlerRegistry();
    nodes.registerNodeHandler('record', (ctx) => {
      recordedConfigs.push(ctx.nodeRef.config);
      return Promise.resolve({ status: 200, message: 'ok', nodeData: { data: ctx.nodeRef.config } });
    });
    worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'metis-engine',
        'src',
        'workflows',
        'index.ts',
      ),
      activities: createActivities({
        store,
        events: new CapturingEventSink(),
        nodes,
        credentials: new FakeCredentialPort(),
      }),
    });
    workerRun = worker.run();

    const identity = await SingleTenantIdentity.create('t1', [
      { userId: 'jeremy', secret: 'pw', role: 'admin' },
    ]);
    const session = await identity.authenticate('jeremy', 'pw');
    token = identity.issueToken(session!);

    app = buildServer({
      executions: new TemporalExecutionAdapter({ client: env.client, taskQueue: TASK_QUEUE }),
      store,
      identity,
      tenantId: 't1',
      schedules: new ScheduleService(store, { client: env.client, taskQueue: TASK_QUEUE }),
    });

    await store.putWorkflowVersion({
      tenantId: 't1',
      workflowId: 'wf-hooked',
      version: 1,
      changeset: 0,
      status: 'published',
      name: 'hooked workflow',
      type: 'workflow',
      definition: {
        nodes: [
          {
            id: HOOK,
            type: 'webhookconfig',
            config: { webhookId: 'hook-1', secret: WEBHOOK_SECRET },
          },
          { id: RECORD, type: 'record', config: { got: `{{${HOOK}.data.order}}` } },
        ],
        edges: [{ source: HOOK, target: RECORD }],
      },
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    worker?.shutdown();
    await workerRun;
    await env?.teardown();
  });

  const waitForCompleted = async (executionId: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const execution = await store.getExecution('t1', executionId);
      if (execution && execution.meta.status !== 'running') return execution;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`execution ${executionId} did not finish`);
  };

  it('starts the right workflow from a signed webhook and binds the payload downstream', async () => {
    const body = JSON.stringify({ order: 4242 });
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('base64');
    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/hook-1',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-metis-signature': signature },
    });
    expect(response.statusCode).toBe(202);
    const { executionId } = response.json() as { executionId: string };
    const execution = await waitForCompleted(executionId);
    expect(execution.meta.status).toBe('completed');
    expect(recordedConfigs).toContainEqual({ got: '4242' });
  }, 60_000);

  it('rejects a bad signature and unknown webhook ids', async () => {
    const body = JSON.stringify({ order: 1 });
    const bad = await app.inject({
      method: 'POST',
      url: '/api/webhooks/hook-1',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-metis-signature': 'forged' },
    });
    expect(bad.statusCode).toBe(401);

    const missing = await app.inject({
      method: 'POST',
      url: '/api/webhooks/no-such-hook',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-metis-signature': 'x' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('creates a native Temporal Schedule, fires it on demand, lists and deletes it', async () => {
    const authed = { authorization: `Bearer ${token}` };
    const create = await app.inject({
      method: 'POST',
      url: '/api/triggers/schedule',
      payload: { workflowId: 'wf-hooked', cron: '0 3 * * *' },
      headers: authed,
    });
    expect(create.statusCode).toBe(201);
    const { scheduleId } = create.json() as { scheduleId: string };
    expect(scheduleId).toBe('sch_t1_wf-hooked');

    const fire = await app.inject({
      method: 'POST',
      url: '/api/triggers/schedule/wf-hooked/run-now',
      headers: authed,
    });
    expect(fire.statusCode).toBe(202);

    // A scheduled fire carries no order field, so the reference token
    // stays unresolved; its presence proves the schedule started the
    // right workflow with schedule-shaped input.
    let fired: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100 && !fired; attempt += 1) {
      fired = recordedConfigs.find(
        (config) => typeof config.got === 'string' && config.got.startsWith('{{node-'),
      );
      if (!fired) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(fired).toBeDefined();

    const listed = await app.inject({ method: 'GET', url: '/api/triggers/schedule', headers: authed });
    expect((listed.json() as { items: { scheduleId: string }[] }).items).toEqual([
      { scheduleId: 'sch_t1_wf-hooked' },
    ]);

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/triggers/schedule/wf-hooked',
      headers: authed,
    });
    expect(removed.statusCode).toBe(204);
    const relisted = await app.inject({ method: 'GET', url: '/api/triggers/schedule', headers: authed });
    expect((relisted.json() as { items: unknown[] }).items).toEqual([]);
  }, 120_000);

  it('rejects scheduling an unpublished workflow', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/triggers/schedule',
      payload: { workflowId: 'wf-ghost', cron: '0 0 * * *' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
  });
});
