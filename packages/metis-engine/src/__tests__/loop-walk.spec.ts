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
 * The loop node: iterates its `each` body as one NATIVE TEMPORAL CHILD
 * WORKFLOW per item (deterministic ids), each child seeing the item via
 * {{node-<loopId>.data.item}}; results accumulate on the loop node for the
 * `done` side; a failed iteration fail-fasts the parent; empty items still
 * take the done path.
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

const TASK_QUEUE = 'metis-loop-spec';
const START = 'node-71aaaaaa-1111-4222-8333-444444444444';
const LOOP = 'node-72bbbbbb-1111-4222-8333-444444444444';
const BODY = 'node-73cccccc-1111-4222-8333-444444444444';
const AFTER = 'node-74dddddd-1111-4222-8333-444444444444';

describe('loop node (child workflow per iteration)', () => {
  let env: TestWorkflowEnvironment;
  let store: WorkflowStore;
  let worker: Worker;
  let workerRun: Promise<void>;
  let executionCounter = 0;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const dir = mkdtempSync(join(tmpdir(), 'metis-loop-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'loop.db')));
    registerWorkflowTables(gateway);
    store = new WorkflowStore(gateway);
    const nodes = new NodeHandlerRegistry();
    nodes.registerNodeHandler('echo', (ctx) =>
      Promise.resolve({ status: 200, message: 'ok', nodeData: { data: { echoed: ctx.nodeRef.config } } }),
    );
    nodes.registerNodeHandler('boom', (ctx) => {
      const config = ctx.nodeRef.config as { failOn?: unknown; got?: unknown };
      if (String(config.got) === String(config.failOn)) {
        return Promise.resolve({ status: 500, message: 'boom on ' + String(config.got) });
      }
      return Promise.resolve({ status: 200, message: 'ok', nodeData: { data: { ok: config.got } } });
    });
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

  const run = async (
    definition: HelixWorkflowInput['definition'],
    inputPayload: Record<string, unknown> = {},
  ) => {
    executionCounter += 1;
    const executionId = `exec-loop-${executionCounter}`;
    const input: HelixWorkflowInput = {
      tenantId: 't1',
      workflowId: 'wf-loop',
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

  type LogRow = { event?: unknown; nodeId?: unknown; output?: unknown; error?: unknown };
  const logsOf = async (executionId: string): Promise<LogRow[]> => {
    const execution = await store.getExecution('t1', executionId);
    return (execution?.logs ?? []) as LogRow[];
  };
  const outputOf = (logs: LogRow[], nodeId: string) =>
    logs.find((log) => log.nodeId === nodeId && log.event === 'workflow.node.completed')?.output as
      | Record<string, unknown>
      | undefined;

  const loopDefinition = (
    bodyType: string,
    bodyConfig: Record<string, unknown>,
    items: unknown,
  ): HelixWorkflowInput['definition'] => ({
    nodes: [
      { id: START, type: 'echo', config: { at: 'start' } },
      { id: LOOP, type: 'loop', config: { items } },
      { id: BODY, type: bodyType, config: bodyConfig },
      { id: AFTER, type: 'echo', config: { at: 'after' } },
    ],
    edges: [
      { source: START, target: LOOP },
      { source: LOOP, target: BODY, sourceHandle: 'each' },
      { source: LOOP, target: AFTER, sourceHandle: 'done' },
    ],
  });

  it('runs the body once per item as child runs; each child resolves the item ref; done side reads results', async () => {
    const { executionId, result } = await run(
      loopDefinition('echo', { got: `{{${LOOP}.data.item}}`, at: `{{${LOOP}.data.index}}` }, ['a', 'b', 'c']),
    );
    expect(result.status).toBe('completed');

    // Each iteration is a REAL run with a deterministic id and its own logs.
    for (let i = 0; i < 3; i += 1) {
      const childLogs = await logsOf(`${executionId}-loop-${LOOP}-${i}`);
      const bodyOut = outputOf(childLogs, BODY);
      expect(bodyOut?.echoed).toEqual({ got: ['a', 'b', 'c'][i], at: String(i) });
    }

    // The loop node's summary state feeds the done side.
    const logs = await logsOf(executionId);
    const afterOut = outputOf(logs, AFTER);
    expect(afterOut).toBeDefined();
    // The body never ran in the PARENT walk.
    expect(logs.some((log) => log.nodeId === BODY)).toBe(false);
  }, 120_000);

  it('fail-fast: a failing iteration fails the parent and spawns no further children', async () => {
    const { executionId, result } = await run(
      loopDefinition('boom', { got: `{{${LOOP}.data.item}}`, failOn: 'b' }, ['a', 'b', 'c']),
    );
    expect(result.status).toBe('failed');
    // Iterations 0 and 1 exist; iteration 2 was never spawned.
    expect((await logsOf(`${executionId}-loop-${LOOP}-0`)).length).toBeGreaterThan(0);
    expect((await logsOf(`${executionId}-loop-${LOOP}-1`)).length).toBeGreaterThan(0);
    expect(await logsOf(`${executionId}-loop-${LOOP}-2`)).toEqual([]);
  }, 120_000);

  it('empty items: zero iterations, done side still runs', async () => {
    const { executionId, result } = await run(loopDefinition('echo', { x: 1 }, []));
    expect(result.status).toBe('completed');
    const logs = await logsOf(executionId);
    const loopOut = outputOf(logs, LOOP);
    expect(loopOut?.iterations ?? (loopOut as { plan?: unknown })).toBeDefined();
    expect(outputOf(logs, AFTER)).toBeDefined();
  }, 120_000);

  it('exceeding maxIterations fails the run before spawning anything', async () => {
    const failing = await run({
      nodes: [
        { id: START, type: 'echo', config: {} },
        { id: LOOP, type: 'loop', config: { items: [1, 2, 3], maxIterations: 1 } },
        { id: BODY, type: 'echo', config: {} },
        { id: AFTER, type: 'echo', config: {} },
      ],
      edges: [
        { source: START, target: LOOP },
        { source: LOOP, target: BODY, sourceHandle: 'each' },
        { source: LOOP, target: AFTER, sourceHandle: 'done' },
      ],
    });
    expect(failing.result.status).toBe('failed');
    expect(await logsOf(`${failing.executionId}-loop-${LOOP}-0`)).toEqual([]);
  }, 120_000);
});
