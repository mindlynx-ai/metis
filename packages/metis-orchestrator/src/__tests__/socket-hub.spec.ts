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
import { io as socketClient, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import {
  FakeCredentialPort,
  LocalEventBus,
  NodeHandlerRegistry,
  SingleTenantIdentity,
  type WorkflowEvent,
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
import { attachSocketHub, type SocketHub } from '../socket-hub.js';

const TASK_QUEUE = 'metis-socket-spec';
const NODE = 'node-c1aaaaaa-1111-4222-8333-444444444444';

describe('run-status WebSocket and catalogue endpoint', () => {
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;
  let app: FastifyInstance;
  let hub: SocketHub;
  let baseUrl: string;
  let token: string;
  let client: Socket;
  const bus = new LocalEventBus();

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const dir = mkdtempSync(join(tmpdir(), 'metis-socket-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'socket.db')));
    registerWorkflowTables(gateway);
    const store = new WorkflowStore(gateway);
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
        events: bus,
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
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    hub = attachSocketHub(app.server, { identity, bus });
    const address = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  }, 180_000);

  afterAll(async () => {
    client?.close();
    await hub?.close();
    await app?.close();
    worker?.shutdown();
    await workerRun;
    await env?.teardown();
  });

  it('streams live execution and node status into the execution room', async () => {
    client = socketClient(baseUrl, {
      path: '/ws/workflows',
      auth: { token },
      transports: ['websocket'],
    });
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', reject);
    });

    const executionId = 'exec-socket-1';
    const received: WorkflowEvent[] = [];
    client.emit('join', { room: `execution:${executionId}` });
    client.on('workflow-event', (event: WorkflowEvent) => received.push(event));
    await new Promise((resolve) => setTimeout(resolve, 100));

    await env.client.workflow.execute('helixWorkflow', {
      args: [
        {
          tenantId: 't1',
          workflowId: 'wf-socket',
          executionId,
          definition: { nodes: [{ id: NODE, type: 'echo', config: { live: true } }], edges: [] },
        },
      ],
      workflowId: executionId,
      taskQueue: TASK_QUEUE,
    });

    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (received.some((event) => event.name === 'workflow.execution.completed')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const names = received.map((event) => event.name);
    expect(names).toContain('workflow.execution.started');
    expect(names).toContain('workflow.node.started');
    expect(names).toContain('workflow.node.completed');
    expect(names).toContain('workflow.execution.completed');
    expect(names.indexOf('workflow.execution.started')).toBeLessThan(
      names.indexOf('workflow.node.completed'),
    );
    expect(received.every((event) => event.executionId === executionId)).toBe(true);
  }, 60_000);

  it('rejects unauthenticated socket connections', async () => {
    const rogue = socketClient(baseUrl, {
      path: '/ws/workflows',
      auth: { token: 'forged' },
      transports: ['websocket'],
    });
    const error = await new Promise<Error>((resolve) => {
      rogue.on('connect_error', resolve);
    });
    expect(error.message).toMatch(/unauthorised/);
    rogue.close();
  });

  it('serves the open catalogue to the palette', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/node-catalogue',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const catalogue = response.json() as { entries: { type: string; tier: string }[] };
    expect(catalogue.entries.length).toBeGreaterThanOrEqual(14);
    expect(catalogue.entries.every((entry) => entry.tier === 'open')).toBe(true);
    expect(catalogue.entries.map((entry) => entry.type)).toContain('switch');
  });
});
