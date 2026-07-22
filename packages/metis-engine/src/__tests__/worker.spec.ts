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
import {
  CapturingEventSink,
  FakeCredentialPort,
  NodeHandlerRegistry,
} from '@mindlynx/metis-ports';
import { DataGateway, SqliteAdapter, WorkflowStore, registerWorkflowTables } from '@mindlynx/metis-data-gateway';
import { createActivities } from '../activities/create-activities.js';
import type { HelixWorkflowInput } from '../types.js';

const TASK_QUEUE = 'metis-worker-spec';

describe('Metis worker: hello-world helixWorkflow', () => {
  let env: TestWorkflowEnvironment;
  let store: WorkflowStore;
  let events: CapturingEventSink;
  let worker: Worker;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const dir = mkdtempSync(join(tmpdir(), 'metis-worker-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'engine.db')));
    registerWorkflowTables(gateway);
    store = new WorkflowStore(gateway);
    events = new CapturingEventSink();
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
        'workflows',
        'index.ts',
      ),
      activities: createActivities({
        store,
        events,
        nodes,
        credentials: new FakeCredentialPort(),
      }),
    });
  }, 180_000);

  afterAll(async () => {
    await env?.teardown();
  });

  it('starts, executes one node and completes, writing META through the DataStore', async () => {
    const input: HelixWorkflowInput = {
      tenantId: 't1',
      workflowId: 'wf-hello',
      executionId: 'exec-hello-1',
      definition: {
        nodes: [{ id: 'n1', type: 'echo', config: { greeting: 'hello metis' } }],
        edges: [],
      },
    };
    const result = await worker.runUntil(
      env.client.workflow.execute('helixWorkflow', {
        args: [input],
        workflowId: input.executionId,
        taskQueue: TASK_QUEUE,
      }),
    );
    expect((result as { status: string }).status).toBe('completed');

    const execution = await store.getExecution('t1', 'exec-hello-1');
    expect(execution?.meta.status).toBe('completed');
    expect(execution?.logs.length).toBeGreaterThan(0);

    const names = events.events.map((event) => event.name);
    expect(names).toContain('workflow.execution.started');
    expect(names).toContain('workflow.node.completed');
    expect(names).toContain('workflow.execution.completed');
  }, 120_000);
});
