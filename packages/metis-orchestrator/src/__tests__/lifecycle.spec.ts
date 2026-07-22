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

const TASK_QUEUE = 'metis-lifecycle-spec';
const SIG = 'node-91aaaaaa-1111-4222-8333-444444444444';
const WORK = 'node-92bbbbbb-1111-4222-8333-444444444444';

describe('lifecycle API over ExecutionPort', () => {
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;
  let app: FastifyInstance;
  let store: WorkflowStore;
  let token: string;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const dir = mkdtempSync(join(tmpdir(), 'metis-lifecycle-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'lifecycle.db')));
    registerWorkflowTables(gateway);
    store = new WorkflowStore(gateway);
    const nodes = new NodeHandlerRegistry();
    nodes.registerNodeHandler('echo', (ctx) =>
      Promise.resolve({ status: 200, message: 'ok', nodeData: { data: { echoed: ctx.nodeRef.config } } }),
    );
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
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    worker?.shutdown();
    await workerRun;
    await env?.teardown();
  });

  const inject = (method: 'GET' | 'POST', url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      payload: body as Record<string, unknown> | undefined,
      headers: { authorization: `Bearer ${token}` },
    });

  const waitForStatus = async (executionId: string, wanted: string[]) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await inject('GET', `/api/executions/${executionId}/status`);
      const { status } = response.json() as { status: string };
      if (wanted.includes(status)) return status;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`execution ${executionId} never reached ${wanted.join('/')}`);
  };

  it('rejects unauthenticated calls', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/executions' });
    expect(response.statusCode).toBe(401);
  });

  it('starts a workflow, reads it back, and describes it', async () => {
    const start = await inject('POST', '/api/executions', {
      workflowId: 'wf-life',
      definition: {
        nodes: [{ id: WORK, type: 'echo', config: { hello: true } }],
        edges: [],
      },
    });
    expect(start.statusCode).toBe(202);
    const { executionId } = start.json() as { executionId: string };
    await waitForStatus(executionId, ['completed']);

    const read = await inject('GET', `/api/executions/${executionId}`);
    expect(read.statusCode).toBe(200);
    const execution = read.json() as { meta: { status: string }; logs: unknown[] };
    expect(execution.meta.status).toBe('completed');
    expect(execution.logs.length).toBeGreaterThan(0);

    const listed = await inject('GET', '/api/executions?limit=10');
    const page = listed.json() as { items: { executionId: string }[] };
    expect(page.items.map((item) => item.executionId)).toContain(executionId);

    const described = await inject('GET', `/api/executions/${executionId}/describe`);
    expect((described.json() as { status: string }).status).toBe('COMPLETED');

    const state = await inject('GET', `/api/executions/${executionId}/state`);
    expect((state.json() as { status: string }).status).toBe('completed');
  }, 60_000);

  it('signals a parked run through the API', async () => {
    const start = await inject('POST', '/api/executions', {
      workflowId: 'wf-signal',
      definition: {
        nodes: [
          { id: SIG, type: 'signal', config: { signalType: 'go' } },
          { id: WORK, type: 'echo', config: {} },
        ],
        edges: [{ source: SIG, target: WORK }],
      },
    });
    const { executionId } = start.json() as { executionId: string };
    const signal = await inject('POST', `/api/executions/${executionId}/signal`, {
      signalType: 'go',
      signalParams: { approved: true },
    });
    expect(signal.statusCode).toBe(202);
    await waitForStatus(executionId, ['completed']);
  }, 60_000);

  it('cancels a parked run through the API', async () => {
    const start = await inject('POST', '/api/executions', {
      workflowId: 'wf-cancel',
      definition: {
        nodes: [
          { id: SIG, type: 'signal', config: { signalType: 'never' } },
          { id: WORK, type: 'echo', config: {} },
        ],
        edges: [{ source: SIG, target: WORK }],
      },
    });
    const { executionId } = start.json() as { executionId: string };
    const cancel = await inject('POST', `/api/executions/${executionId}/cancel`, {
      reason: 'test cancel',
    });
    expect(cancel.statusCode).toBe(202);
    const status = await waitForStatus(executionId, ['completed', 'cancelled']);
    expect(status).toBe('completed');
    const read = await inject('GET', `/api/executions/${executionId}`);
    expect((read.json() as { meta: { status: string } }).meta.status).toBe('cancelled');
  }, 60_000);

  it('rejects invalid definitions with 422 and missing workflows with 404', async () => {
    const invalid = await inject('POST', '/api/executions', {
      workflowId: 'wf-bad',
      definition: { nodes: [], edges: [] },
    });
    expect(invalid.statusCode).toBe(422);

    const missing = await inject('POST', '/api/executions', { workflowId: 'wf-unpublished' });
    expect(missing.statusCode).toBe(404);
  });
});
