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

const TASK_QUEUE = 'metis-graph-walk-spec';
const NODE_A = 'node-aaaaaaaa-1111-4222-8333-444444444444';
const NODE_B = 'node-bbbbbbbb-1111-4222-8333-444444444444';
const NODE_C = 'node-cccccccc-1111-4222-8333-444444444444';
const NODE_D = 'node-dddddddd-1111-4222-8333-444444444444';

describe('graph walk', () => {
  let env: TestWorkflowEnvironment;
  let store: WorkflowStore;
  let events: CapturingEventSink;
  let worker: Worker;
  let workerRun: Promise<void>;
  let executionCounter = 0;
  const recordedConfigs: Record<string, unknown>[] = [];

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const dir = mkdtempSync(join(tmpdir(), 'metis-walk-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'walk.db')));
    registerWorkflowTables(gateway);
    store = new WorkflowStore(gateway);
    events = new CapturingEventSink();
    const nodes = new NodeHandlerRegistry();
    nodes.registerNodeHandler('echo', (ctx) =>
      Promise.resolve({ status: 200, message: 'ok', nodeData: { data: { echoed: ctx.nodeRef.config } } }),
    );
    nodes.registerNodeHandler('boom', () => Promise.reject(new Error('deliberate failure')));
    nodes.registerNodeHandler('record', (ctx) => {
      recordedConfigs.push(ctx.nodeRef.config);
      return Promise.resolve({ status: 200, message: 'ok', nodeData: { data: ctx.nodeRef.config } });
    });
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

  const runWorkflow = async (definition: HelixWorkflowInput['definition']) => {
    executionCounter += 1;
    const executionId = `exec-walk-${executionCounter}`;
    const input: HelixWorkflowInput = {
      tenantId: 't1',
      workflowId: 'wf-walk',
      executionId,
      definition,
    };
    const result = await env.client.workflow.execute('helixWorkflow', {
      args: [input],
      workflowId: executionId,
      taskQueue: TASK_QUEUE,
    });
    return { executionId, result: result as { status: string } };
  };

  const startedOrder = async (executionId: string) => {
    const execution = await store.getExecution('t1', executionId);
    return (execution?.logs ?? [])
      .filter((log) => log.event === 'workflow.node.started')
      .map((log) => log.nodeId);
  };

  it('runs a linear chain in edge order with per-node LOG rows', async () => {
    const { executionId, result } = await runWorkflow({
      nodes: [
        { id: NODE_A, type: 'echo', config: { step: 'a' } },
        { id: NODE_B, type: 'echo', config: { step: 'b' } },
        { id: NODE_C, type: 'echo', config: { step: 'c' } },
        { id: NODE_D, type: 'echo', config: { step: 'd' } },
      ],
      edges: [
        { source: NODE_A, target: NODE_B },
        { source: NODE_B, target: NODE_C },
        { source: NODE_C, target: NODE_D },
      ],
    });
    expect(result.status).toBe('completed');
    expect(await startedOrder(executionId)).toEqual([NODE_A, NODE_B, NODE_C, NODE_D]);
  }, 60_000);

  it('joins a diamond fan-in exactly once, after both branches, with cross-branch substitution', async () => {
    const { executionId, result } = await runWorkflow({
      nodes: [
        { id: NODE_A, type: 'echo', config: { step: 'a' } },
        { id: NODE_B, type: 'echo', config: { tag: 'left' } },
        { id: NODE_C, type: 'echo', config: { tag: 'right' } },
        { id: NODE_D, type: 'record', config: { joined: `{{${NODE_B}.data.echoed.tag}}` } },
      ],
      edges: [
        { source: NODE_A, target: NODE_B },
        { source: NODE_A, target: NODE_C },
        { source: NODE_B, target: NODE_D },
        { source: NODE_C, target: NODE_D },
      ],
    });
    expect(result.status).toBe('completed');
    const order = await startedOrder(executionId);
    expect(order).toHaveLength(4);
    expect(order[0]).toBe(NODE_A);
    expect(order[3]).toBe(NODE_D);
    expect(order.filter((id) => id === NODE_D)).toHaveLength(1);

    const execution = await store.getExecution('t1', executionId);
    const joinCompleted = execution?.logs.find(
      (log) => log.nodeId === NODE_D && log.event === 'workflow.node.completed',
    );
    expect(joinCompleted).toBeDefined();

    const joinStarted = events.events.filter(
      (event) =>
        event.name === 'workflow.node.started' &&
        event.nodeId === NODE_D &&
        event.executionId === executionId,
    );
    expect(joinStarted).toHaveLength(1);
    expect(recordedConfigs).toEqual([{ joined: 'left' }]);
  }, 60_000);

  it('fails the workflow on a failing node and stops the walk', async () => {
    const { executionId, result } = await runWorkflow({
      nodes: [
        { id: NODE_A, type: 'echo', config: {} },
        { id: NODE_B, type: 'boom', config: {} },
        { id: NODE_C, type: 'echo', config: {} },
      ],
      edges: [
        { source: NODE_A, target: NODE_B },
        { source: NODE_B, target: NODE_C },
      ],
    });
    expect(result.status).toBe('failed');
    const execution = await store.getExecution('t1', executionId);
    expect(execution?.meta.status).toBe('failed');
    expect(await startedOrder(executionId)).toEqual([NODE_A, NODE_B]);
  }, 60_000);
});
