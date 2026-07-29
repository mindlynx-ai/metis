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
  let workerRun: Promise<void>;

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
    // Kept running for the whole file: runUntil shuts the worker down when its
    // promise settles, leaving nothing for a second case to run on.
    workerRun = worker.run();
  }, 180_000);

  afterAll(async () => {
    worker?.shutdown();
    await workerRun;
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
    const result = await env.client.workflow.execute('helixWorkflow', {
      args: [input],
      workflowId: input.executionId,
      taskQueue: TASK_QUEUE,
    });
    expect((result as { status: string }).status).toBe('completed');

    const execution = await store.getExecution('t1', 'exec-hello-1');
    expect(execution?.meta.status).toBe('completed');
    expect(execution?.logs.length).toBeGreaterThan(0);

    const names = events.events.map((event) => event.name);
    expect(names).toContain('workflow.execution.started');
    expect(names).toContain('workflow.node.completed');
    expect(names).toContain('workflow.execution.completed');
  }, 120_000);

  it('records under the id Temporal minted, not a stale executionId in the args', async () => {
    // A Temporal Schedule replays one action payload at every tick, so the
    // executionId in those args is a constant: taking it at face value gives a
    // schedule one run row, overwritten for ever. The id Temporal minted (for a
    // scheduled fire, the action id with the fire time appended) is the only
    // per-fire identity available, and it is what the run must be filed under.
    const stale = 'exec_sch_t1_wf-hello';
    const minted = `${stale}-2026-07-29T09:00:00Z`;
    const result = await env.client.workflow.execute('helixWorkflow', {
      args: [
        {
          tenantId: 't1',
          workflowId: 'wf-hello',
          executionId: stale,
          definition: { nodes: [{ id: 'n1', type: 'echo', config: {} }], edges: [] },
        } satisfies HelixWorkflowInput,
      ],
      workflowId: minted,
      taskQueue: TASK_QUEUE,
    });
    expect((result as { status: string }).status).toBe('completed');
    expect((await store.getExecution('t1', minted))?.meta.status).toBe('completed');
    expect(await store.getExecution('t1', stale)).toBeUndefined();
  }, 120_000);
});
