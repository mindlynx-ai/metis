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

const TASK_QUEUE = 'metis-switch-spec';
const SWITCH = 'node-51aaaaaa-1111-4222-8333-444444444444';
const LEFT = 'node-52bbbbbb-1111-4222-8333-444444444444';
const RIGHT = 'node-53cccccc-1111-4222-8333-444444444444';
const JOIN = 'node-54dddddd-1111-4222-8333-444444444444';
const RIGHT_CHILD = 'node-55eeeeee-1111-4222-8333-444444444444';

describe('switch orphan propagation', () => {
  let env: TestWorkflowEnvironment;
  let store: WorkflowStore;
  let worker: Worker;
  let workerRun: Promise<void>;
  let executionCounter = 0;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const dir = mkdtempSync(join(tmpdir(), 'metis-switch-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'switch.db')));
    registerWorkflowTables(gateway);
    store = new WorkflowStore(gateway);
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
        events: new CapturingEventSink(),
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

  const definition: HelixWorkflowInput['definition'] = {
    nodes: [
      {
        id: SWITCH,
        type: 'switch',
        config: {
          switchOptions: [
            {
              id: 'go-left',
              conditions: [{ property: 'input.kind', checkValue: 'left', checkOperator: '===' }],
            },
          ],
        },
      },
      { id: LEFT, type: 'echo', config: { branch: 'left' } },
      { id: RIGHT, type: 'echo', config: { branch: 'right' } },
      { id: RIGHT_CHILD, type: 'echo', config: { branch: 'right-child' } },
      { id: JOIN, type: 'echo', config: { branch: 'join' } },
    ],
    edges: [
      { source: SWITCH, target: LEFT, sourceHandle: 'source-go-left' },
      { source: SWITCH, target: RIGHT, sourceHandle: 'source-default' },
      { source: RIGHT, target: RIGHT_CHILD },
      { source: LEFT, target: JOIN },
      { source: RIGHT_CHILD, target: JOIN },
    ],
  };

  const runWorkflow = async (inputPayload: Record<string, unknown>) => {
    executionCounter += 1;
    const executionId = `exec-switch-${executionCounter}`;
    const input: HelixWorkflowInput = {
      tenantId: 't1',
      workflowId: 'wf-switch',
      executionId,
      definition,
      input: inputPayload,
    };
    const result = await env.client.workflow.execute('helixWorkflow', {
      args: [input],
      workflowId: executionId,
      taskQueue: TASK_QUEUE,
    });
    return { executionId, result: result as { status: string } };
  };

  const startedNodes = async (executionId: string) => {
    const execution = await store.getExecution('t1', executionId);
    return (execution?.logs ?? [])
      .filter((log) => log.event === 'workflow.node.started')
      .map((log) => log.nodeId);
  };

  it('runs the selected branch, orphans the losing branch and its descendants, and still joins', async () => {
    const { executionId, result } = await runWorkflow({ kind: 'left' });
    expect(result.status).toBe('completed');
    const started = await startedNodes(executionId);
    expect(started).toContain(SWITCH);
    expect(started).toContain(LEFT);
    expect(started).toContain(JOIN);
    expect(started).not.toContain(RIGHT);
    expect(started).not.toContain(RIGHT_CHILD);
    expect(started.filter((id) => id === JOIN)).toHaveLength(1);
  }, 60_000);

  it('takes the default branch when no condition matches', async () => {
    const { executionId, result } = await runWorkflow({ kind: 'elsewhere' });
    expect(result.status).toBe('completed');
    const started = await startedNodes(executionId);
    expect(started).toContain(RIGHT);
    expect(started).toContain(RIGHT_CHILD);
    expect(started).toContain(JOIN);
    expect(started).not.toContain(LEFT);
  }, 60_000);
});
