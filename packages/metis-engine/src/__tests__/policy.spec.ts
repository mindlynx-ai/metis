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

/**
 * Node policy enforcement (the inspector's Policy tab made real):
 *   - retries/backoffSeconds/timeoutSeconds wrap the handler call inside the
 *     executeNode activity (Tier A: plain activity calls, no Temporal);
 *   - onFailure: 'continue' lets the walk carry on past a failed node
 *     (Tier B: real workflow through a time-skipping Temporal env).
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
import type { EngineActivities, HelixWorkflowInput, NodePolicy } from '../types.js';

const NODE_OK = 'node-aaaaaaaa-1111-4222-8333-444444444444';
const NODE_BOOM = 'node-bbbbbbbb-1111-4222-8333-444444444444';
const NODE_AFTER = 'node-cccccccc-1111-4222-8333-444444444444';
const NODE_JOIN = 'node-dddddddd-1111-4222-8333-444444444444';
const NODE_ENTRY = 'node-eeeeeeee-1111-4222-8333-444444444444';

/** A fresh activity surface with counting handlers over a temp sqlite store. */
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'metis-policy-'));
  const gateway = new DataGateway(new SqliteAdapter(join(dir, 'policy.db')));
  registerWorkflowTables(gateway);
  const store = new WorkflowStore(gateway);
  const nodes = new NodeHandlerRegistry();
  const calls: Record<string, number> = {};
  const callTimes: number[] = [];
  nodes.registerNodeHandler('flaky', (ctx) => {
    const failuresWanted = Number(ctx.nodeRef.config.failures ?? 0);
    calls[ctx.nodeRef.id] = (calls[ctx.nodeRef.id] ?? 0) + 1;
    callTimes.push(Date.now());
    if (calls[ctx.nodeRef.id] <= failuresWanted) {
      return Promise.resolve({ status: 500, message: 'flaky failure' });
    }
    return Promise.resolve({ status: 200, message: 'ok', nodeData: { data: { ok: true } } });
  });
  nodes.registerNodeHandler('never', () => new Promise(() => undefined));
  nodes.registerNodeHandler('echo', (ctx) =>
    Promise.resolve({ status: 200, message: 'ok', nodeData: { data: { echoed: ctx.nodeRef.config } } }),
  );
  const activities = createActivities({
    store,
    events: new CapturingEventSink(),
    nodes,
    credentials: new FakeCredentialPort(),
  });
  return { activities, store, calls, callTimes };
}

let sequenceCounter = 0;
const execute = (
  activities: EngineActivities,
  type: string,
  config: Record<string, unknown>,
  policy?: NodePolicy,
  id = NODE_OK,
) => {
  sequenceCounter += 1;
  return activities.executeNode({
    tenantId: 't1',
    workflowId: 'wf-policy',
    executionId: `exec-policy-${sequenceCounter}`,
    node: { id, type, config, policy },
    states: [],
    sequence: 1,
  });
};

describe('policy tier A: retries, backoff and timeout inside the activity', () => {
  it('retries a failing handler until it succeeds and records the attempts', async () => {
    const { activities, calls, store } = harness();
    const result = await execute(activities, 'flaky', { failures: 2 }, { retries: 2 });
    expect(result.outcome).toBe('completed');
    expect(calls[NODE_OK]).toBe(3);
    expect(result.attempts).toBe(3);
    // The terminal log row carries the attempt count (getExecution needs the
    // META row the workflow normally writes, so seed it here).
    const executionId = `exec-policy-${sequenceCounter}`;
    await store.writeExecutionMeta({
      tenantId: 't1',
      executionId,
      workflowId: 'wf-policy',
      status: 'running',
      startTime: new Date().toISOString(),
    });
    const execution = await store.getExecution('t1', executionId);
    const terminal = (execution?.logs ?? []).find((log) => log.event === 'workflow.node.completed');
    expect(terminal?.attempts).toBe(3);
  });

  it('fails once the retry budget is exhausted', async () => {
    const { activities, calls } = harness();
    const result = await execute(activities, 'flaky', { failures: 99 }, { retries: 1 });
    expect(result.outcome).toBe('failed');
    expect(calls[NODE_OK]).toBe(2);
  });

  it('no policy means exactly one attempt', async () => {
    const { activities, calls } = harness();
    const result = await execute(activities, 'flaky', { failures: 99 });
    expect(result.outcome).toBe('failed');
    expect(calls[NODE_OK]).toBe(1);
  });

  it('waits the backoff between attempts', async () => {
    const { activities, callTimes } = harness();
    await execute(activities, 'flaky', { failures: 1 }, { retries: 1, backoffSeconds: 0.08 });
    expect(callTimes).toHaveLength(2);
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(70);
  });

  it('times out a hung handler', async () => {
    const { activities } = harness();
    const result = await execute(activities, 'never', {}, { timeoutSeconds: 0.05 });
    expect(result.outcome).toBe('failed');
    expect(result.error?.message).toMatch(/timed out/);
  });

  it('a timeout consumes the retry budget too', async () => {
    const { activities } = harness();
    const result = await execute(activities, 'never', {}, { retries: 1, timeoutSeconds: 0.05 });
    expect(result.outcome).toBe('failed');
    expect(result.attempts).toBe(2);
  });

  it('inline control nodes ignore the retry policy', async () => {
    const { activities } = harness();
    // A switch with no options completes inline; policy must not wrap it.
    const result = await execute(activities, 'switch', {}, { retries: 3 });
    expect(result.outcome).toBe('completed');
    expect(result.attempts).toBeUndefined();
  });
});

describe('policy tier B: onFailure through the real workflow walk', () => {
  let env: TestWorkflowEnvironment;
  let store: WorkflowStore;
  let worker: Worker;
  let workerRun: Promise<void>;
  let executionCounter = 0;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const dir = mkdtempSync(join(tmpdir(), 'metis-policy-wf-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'policy-wf.db')));
    registerWorkflowTables(gateway);
    store = new WorkflowStore(gateway);
    const nodes = new NodeHandlerRegistry();
    nodes.registerNodeHandler('echo', (ctx) =>
      Promise.resolve({ status: 200, message: 'ok', nodeData: { data: { echoed: ctx.nodeRef.config } } }),
    );
    nodes.registerNodeHandler('boom', () => Promise.reject(new Error('deliberate failure')));
    worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'metis-policy-spec',
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

  const runWorkflow = async (definition: HelixWorkflowInput['definition']) => {
    executionCounter += 1;
    const executionId = `exec-policy-wf-${executionCounter}`;
    const result = await env.client.workflow.execute('helixWorkflow', {
      args: [{ tenantId: 't1', workflowId: 'wf-policy', executionId, definition }],
      workflowId: executionId,
      taskQueue: 'metis-policy-spec',
    });
    return { executionId, result: result as { status: string } };
  };

  const nodeEvents = async (executionId: string, nodeId: string) => {
    const execution = await store.getExecution('t1', executionId);
    return (execution?.logs ?? [])
      .filter((log) => log.nodeId === nodeId)
      .map((log) => log.event);
  };

  it('onFailure continue: the run completes and downstream still executes', async () => {
    const { executionId, result } = await runWorkflow({
      nodes: [
        { id: NODE_BOOM, type: 'boom', config: {}, policy: { onFailure: 'continue' } },
        { id: NODE_AFTER, type: 'echo', config: { step: 'after' } },
      ],
      edges: [{ source: NODE_BOOM, target: NODE_AFTER }],
    });
    expect(result.status).toBe('completed');
    expect(await nodeEvents(executionId, NODE_BOOM)).toContain('workflow.node.failed');
    expect(await nodeEvents(executionId, NODE_AFTER)).toContain('workflow.node.completed');
  });

  it('default halt: the run fails and downstream never runs', async () => {
    const { executionId, result } = await runWorkflow({
      nodes: [
        { id: NODE_BOOM, type: 'boom', config: {} },
        { id: NODE_AFTER, type: 'echo', config: { step: 'after' } },
      ],
      edges: [{ source: NODE_BOOM, target: NODE_AFTER }],
    });
    expect(result.status).toBe('failed');
    expect(await nodeEvents(executionId, NODE_AFTER)).toHaveLength(0);
  });

  it('a fan-in joins exactly once past a failed-but-continue branch', async () => {
    const { executionId, result } = await runWorkflow({
      nodes: [
        { id: NODE_ENTRY, type: 'echo', config: { step: 'entry' } },
        { id: NODE_BOOM, type: 'boom', config: {}, policy: { onFailure: 'continue' } },
        { id: NODE_OK, type: 'echo', config: { step: 'ok' } },
        { id: NODE_JOIN, type: 'echo', config: { step: 'join' } },
      ],
      edges: [
        { source: NODE_ENTRY, target: NODE_BOOM },
        { source: NODE_ENTRY, target: NODE_OK },
        { source: NODE_BOOM, target: NODE_JOIN },
        { source: NODE_OK, target: NODE_JOIN },
      ],
    });
    expect(result.status).toBe('completed');
    const events = await nodeEvents(executionId, NODE_JOIN);
    expect(events.filter((event) => event === 'workflow.node.started')).toHaveLength(1);
    expect(events).toContain('workflow.node.completed');
  });
});
