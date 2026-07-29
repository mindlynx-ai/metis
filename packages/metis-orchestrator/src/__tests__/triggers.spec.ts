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
    // Whole-value token: the webhook payload's number binds downstream as a
    // number, so an amount or an id keeps its type on the way to an API.
    expect(recordedConfigs).toContainEqual({ got: 4242 });
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

  it('gives every fire its own execution record, so the run history survives', async () => {
    const authed = { authorization: `Bearer ${token}` };
    // Its own workflow, so its own schedule id: a schedule deleted by an
    // earlier case and re-created here would race its own teardown.
    await store.putWorkflowVersion({
      tenantId: 't1',
      workflowId: 'wf-ticker',
      version: 1,
      changeset: 0,
      status: 'published',
      name: 'ticker workflow',
      type: 'workflow',
      definition: {
        nodes: [
          { id: HOOK, type: 'scheduleconfig', config: { cron: '0 4 * * *' } },
          { id: RECORD, type: 'record', config: { tick: true } },
        ],
        edges: [{ source: HOOK, target: RECORD }],
      },
    });
    const create = await app.inject({
      method: 'POST',
      url: '/api/triggers/schedule',
      payload: { workflowId: 'wf-ticker', cron: '0 4 * * *' },
      headers: authed,
    });
    expect(create.statusCode).toBe(201);

    const executionIds = async (): Promise<string[]> => {
      const page = await store.listExecutions('t1', { workflowId: 'wf-ticker', limit: 50 });
      return page.items.map((item) => String(item.executionId));
    };
    const fired: string[] = [];
    for (let fire = 0; fire < 3; fire += 1) {
      // Temporal derives the per-fire id from the nominal fire time truncated
      // to the second, so two fires inside one second would collide by design.
      // Space them, and let each run finish (the schedule skips on overlap)
      // before asking for the next.
      if (fire > 0) await new Promise((resolve) => setTimeout(resolve, 1100));
      const trigger = await app.inject({
        method: 'POST',
        url: '/api/triggers/schedule/wf-ticker/run-now',
        headers: authed,
      });
      expect(trigger.statusCode).toBe(202);
      let fresh: string | undefined;
      for (let attempt = 0; attempt < 200 && !fresh; attempt += 1) {
        fresh = (await executionIds()).find((id) => !fired.includes(id));
        if (!fresh) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(fresh).toBeDefined();
      await waitForCompleted(fresh!);
      fired.push(fresh!);
    }

    // Three fires, three records: the defect was one record, overwritten.
    expect(new Set(fired).size).toBe(3);
    for (const executionId of fired) {
      // Traceable both ways: the schedule that produced the run is readable
      // off the id, and what follows it is the instant the run was due.
      expect(executionId.startsWith('exec_sch_t1_wf-ticker-')).toBe(true);
      const firedAt = executionId.slice('exec_sch_t1_wf-ticker-'.length);
      expect(Number.isNaN(Date.parse(firedAt))).toBe(false);
      // The id Temporal answers to, so cancel and terminate still reach it.
      const description = await env.client.workflow.getHandle(executionId).describe();
      expect(description.workflowId).toBe(executionId);
    }

    await app.inject({ method: 'DELETE', url: '/api/triggers/schedule/wf-ticker', headers: authed });
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
