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
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { createActivities } from '../activities/create-activities.js';
import type { HelixWorkflowInput } from '../types.js';

const TASK_QUEUE = 'metis-upgrade-spec';
const START = 'node-81aaaaaa-1111-4222-8333-444444444444';
const PAID = 'node-82bbbbbb-1111-4222-8333-444444444444';
const AFTER = 'node-83cccccc-1111-4222-8333-444444444444';

describe('unregistered-node upgrade response', () => {
  let env: TestWorkflowEnvironment;
  let store: WorkflowStore;
  let events: CapturingEventSink;
  let worker: Worker;
  let workerRun: Promise<void>;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const dir = mkdtempSync(join(tmpdir(), 'metis-upgrade-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'upgrade.db')));
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
      workflowsPath: join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows', 'index.ts'),
      activities: createActivities({
        store,
        events,
        nodes,
        credentials: new FakeCredentialPort(),
      }),
    });
    workerRun = worker.run();
  }, 180_000);

  afterAll(async () => {
    worker?.shutdown();
    await workerRun;
    await env?.teardown();
  });

  it('a paid node type does not fail the run; it is marked unimplemented and the walk continues', async () => {
    const definition: HelixWorkflowInput['definition'] = {
      nodes: [
        { id: START, type: 'echo', config: { step: 'start' } },
        { id: PAID, type: 'cortex.memory.read', config: { scope: 'working' } },
        { id: AFTER, type: 'echo', config: { step: 'after' } },
      ],
      edges: [
        { source: START, target: PAID },
        { source: PAID, target: AFTER },
      ],
    };
    const input: HelixWorkflowInput = {
      tenantId: 't1',
      workflowId: 'wf-upgrade',
      executionId: 'exec-upgrade-1',
      definition,
    };
    const result = (await env.client.workflow.execute('helixWorkflow', {
      args: [input],
      workflowId: input.executionId,
      taskQueue: TASK_QUEUE,
    })) as { status: string };
    expect(result.status).toBe('completed');

    const execution = await store.getExecution('t1', 'exec-upgrade-1');
    expect(execution?.meta.status).toBe('completed');
    const paidLog = execution?.logs.find(
      (log) => log.nodeId === PAID && log.event === 'workflow.node.unimplemented',
    );
    expect(paidLog).toBeDefined();
    expect(paidLog?.outcome).toBe('unimplemented');

    const unimplementedEvent = events.events.find(
      (event) =>
        event.name === 'workflow.node.unimplemented' && event.executionId === 'exec-upgrade-1',
    );
    expect(unimplementedEvent?.nodeId).toBe(PAID);

    const afterStarted = execution?.logs.find(
      (log) => log.nodeId === AFTER && log.event === 'workflow.node.started',
    );
    expect(afterStarted).toBeDefined();

    expect(JSON.parse(JSON.stringify(definition))).toEqual(definition);
  }, 60_000);
});
