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
 * The three flow nodes (n8n-gap): noop passes through, stopanderror halts the
 * run with its configured message, and merge joins fan-in branches (append /
 * combine / pick) - orphan-aware, so a switch's dead branch never pollutes the
 * merged payload. All engine-inline; generic in/out, node-specific config only.
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

const TASK_QUEUE = 'metis-flow-nodes-spec';
const ROOT = 'node-61aaaaaa-1111-4222-8333-444444444444';
const A = 'node-62bbbbbb-1111-4222-8333-444444444444';
const B = 'node-63cccccc-1111-4222-8333-444444444444';
const MID = 'node-64dddddd-1111-4222-8333-444444444444';
const TAIL = 'node-65eeeeee-1111-4222-8333-444444444444';
const SWITCH = 'node-66ffffff-1111-4222-8333-444444444444';

describe('flow nodes: noop, stopanderror, merge', () => {
  let env: TestWorkflowEnvironment;
  let store: WorkflowStore;
  let worker: Worker;
  let workerRun: Promise<void>;
  let executionCounter = 0;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const dir = mkdtempSync(join(tmpdir(), 'metis-flow-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'flow.db')));
    registerWorkflowTables(gateway);
    store = new WorkflowStore(gateway);
    const nodes = new NodeHandlerRegistry();
    nodes.registerNodeHandler('echo', (ctx) =>
      Promise.resolve({ status: 200, message: 'ok', nodeData: { data: { echoed: ctx.nodeRef.config } } }),
    );
    // Outputs its config as-is: lets the combine test show a real shallow merge.
    nodes.registerNodeHandler('flat', (ctx) =>
      Promise.resolve({ status: 200, message: 'ok', nodeData: { data: ctx.nodeRef.config } }),
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

  const run = async (
    definition: HelixWorkflowInput['definition'],
    inputPayload: Record<string, unknown> = {},
  ) => {
    executionCounter += 1;
    const executionId = `exec-flow-${executionCounter}`;
    const input: HelixWorkflowInput = {
      tenantId: 't1',
      workflowId: 'wf-flow',
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
  const startedNodes = (logs: LogRow[]) =>
    logs.filter((log) => log.event === 'workflow.node.started').map((log) => log.nodeId);
  const outputOf = (logs: LogRow[], nodeId: string) =>
    logs.find((log) => log.nodeId === nodeId && log.event === 'workflow.node.completed')?.output as
      | Record<string, unknown>
      | undefined;

  it('noop passes through: downstream still runs and the run completes', async () => {
    const { executionId, result } = await run({
      nodes: [
        { id: ROOT, type: 'echo', config: { at: 'root' } },
        { id: MID, type: 'noop', config: {} },
        { id: TAIL, type: 'echo', config: { at: 'tail' } },
      ],
      edges: [
        { source: ROOT, target: MID },
        { source: MID, target: TAIL },
      ],
    });
    expect(result.status).toBe('completed');
    const started = startedNodes(await logsOf(executionId));
    expect(started).toEqual(expect.arrayContaining([ROOT, MID, TAIL]));
  }, 60_000);

  it('stopanderror fails the run with the configured (template-resolved) message and halts the walk', async () => {
    const { executionId, result } = await run({
      nodes: [
        { id: ROOT, type: 'echo', config: { reason: 'over-limit' } },
        { id: MID, type: 'stopanderror', config: { message: `Rejected: {{${ROOT}.data.echoed.reason}}` } },
        { id: TAIL, type: 'echo', config: { at: 'tail' } },
      ],
      edges: [
        { source: ROOT, target: MID },
        { source: MID, target: TAIL },
      ],
    });
    expect(result.status).toBe('failed');
    const logs = await logsOf(executionId);
    expect(startedNodes(logs)).not.toContain(TAIL);
    const failure = logs.find((log) => log.nodeId === MID && log.event === 'workflow.node.failed') as
      | { error?: { message?: string } }
      | undefined;
    expect(failure?.error?.message).toBe('Rejected: over-limit');
  }, 60_000);

  it('merge append joins fan-in branches into an items array, in source order', async () => {
    const { executionId, result } = await run({
      nodes: [
        { id: ROOT, type: 'echo', config: { at: 'root' } },
        { id: A, type: 'echo', config: { at: 'a' } },
        { id: B, type: 'echo', config: { at: 'b' } },
        { id: MID, type: 'merge', config: { mode: 'append' } },
        { id: TAIL, type: 'echo', config: { at: 'tail' } },
      ],
      edges: [
        { source: ROOT, target: A },
        { source: ROOT, target: B },
        { source: A, target: MID },
        { source: B, target: MID },
        { source: MID, target: TAIL },
      ],
    });
    expect(result.status).toBe('completed');
    const logs = await logsOf(executionId);
    // The join fires exactly once.
    expect(startedNodes(logs).filter((id) => id === MID)).toHaveLength(1);
    const output = outputOf(logs, MID);
    expect(output?.count).toBe(2);
    expect(output?.items).toEqual([{ echoed: { at: 'a' } }, { echoed: { at: 'b' } }]);
  }, 60_000);

  it('merge combine shallow-merges object outputs, later sources winning', async () => {
    const { executionId, result } = await run({
      nodes: [
        { id: ROOT, type: 'echo', config: { at: 'root' } },
        { id: A, type: 'flat', config: { shared: 'from-a', onlyA: 1 } },
        { id: B, type: 'flat', config: { shared: 'from-b', onlyB: 2 } },
        { id: MID, type: 'merge', config: { mode: 'combine' } },
      ],
      edges: [
        { source: ROOT, target: A },
        { source: ROOT, target: B },
        { source: A, target: MID },
        { source: B, target: MID },
      ],
    });
    expect(result.status).toBe('completed');
    const output = outputOf(await logsOf(executionId), MID);
    // Shallow merge across the two outputs; the later source wins shared keys.
    expect(output).toEqual({ shared: 'from-b', onlyA: 1, onlyB: 2 });
  }, 60_000);

  it('filter splits elements kept/discarded and orphans an empty side', async () => {
    const items = [
      { id: 1, status: 'paid' },
      { id: 2, status: 'pending' },
      { id: 3, status: 'paid' },
    ];
    const definition: HelixWorkflowInput['definition'] = {
      nodes: [
        { id: ROOT, type: 'echo', config: {} },
        {
          id: MID,
          type: 'filter',
          config: { items, conditions: [{ field: 'status', checkOperator: '===', checkValue: 'paid' }] },
        },
        { id: A, type: 'echo', config: { side: 'kept' } },
        { id: B, type: 'echo', config: { side: 'discarded' } },
      ],
      edges: [
        { source: ROOT, target: MID },
        { source: MID, target: A, sourceHandle: 'kept' },
        { source: MID, target: B, sourceHandle: 'discarded' },
      ],
    };
    const { executionId, result } = await run(definition);
    expect(result.status).toBe('completed');
    const logs = await logsOf(executionId);
    const output = outputOf(logs, MID);
    expect(output?.keptCount).toBe(2);
    expect(output?.discardedCount).toBe(1);
    // Both sides non-empty: both branches ran.
    expect(startedNodes(logs)).toEqual(expect.arrayContaining([A, B]));

    // All elements pass: the discarded side is orphaned.
    const allPass = {
      ...definition,
      nodes: definition.nodes.map((node) =>
        node.id === MID
          ? { ...node, config: { items, conditions: [{ field: 'id', checkOperator: '>', checkValue: '0' }] } }
          : node,
      ),
    };
    const second = await run(allPass);
    expect(second.result.status).toBe('completed');
    const secondStarted = startedNodes(await logsOf(second.executionId));
    expect(secondStarted).toContain(A);
    expect(secondStarted).not.toContain(B);
  }, 60_000);

  it('compare datasets routes four ways and orphans empty sides', async () => {
    const definition: HelixWorkflowInput['definition'] = {
      nodes: [
        { id: ROOT, type: 'echo', config: {} },
        {
          id: MID,
          type: 'comparedatasets',
          config: {
            itemsA: [
              { email: 'ada@x.com', tier: 'gold' },
              { email: 'grace@x.com', tier: 'gold' },
            ],
            itemsB: [
              { email: 'ada@x.com', tier: 'gold' },
              { email: 'mh@x.com', tier: 'gold' },
            ],
            matchFields: 'email',
          },
        },
        { id: A, type: 'echo', config: { side: 'aOnly' } },
        { id: B, type: 'echo', config: { side: 'different' } },
      ],
      edges: [
        { source: ROOT, target: MID },
        { source: MID, target: A, sourceHandle: 'aOnly' },
        { source: MID, target: B, sourceHandle: 'different' },
      ],
    };
    const { executionId, result } = await run(definition);
    expect(result.status).toBe('completed');
    const logs = await logsOf(executionId);
    const output = outputOf(logs, MID);
    expect(output?.counts).toEqual({ aOnly: 1, same: 1, different: 0, bOnly: 1 });
    const started = startedNodes(logs);
    expect(started).toContain(A); // grace is only in A
    expect(started).not.toContain(B); // nothing differed -> orphaned
  }, 60_000);

  it('merge pick is orphan-aware: a switch-dead branch never pollutes the pick', async () => {
    const { executionId, result } = await run(
      {
        nodes: [
          {
            id: SWITCH,
            type: 'switch',
            config: {
              switchOptions: [
                { id: 'left', conditions: [{ property: 'input.kind', checkValue: 'left', checkOperator: '===' }] },
              ],
            },
          },
          { id: A, type: 'echo', config: { took: 'left' } },
          { id: B, type: 'echo', config: { took: 'default' } },
          { id: MID, type: 'merge', config: { mode: 'pick' } },
          { id: TAIL, type: 'echo', config: { at: 'tail' } },
        ],
        edges: [
          { source: SWITCH, target: A, sourceHandle: 'source-left' },
          { source: SWITCH, target: B, sourceHandle: 'source-default' },
          { source: A, target: MID },
          { source: B, target: MID },
          { source: MID, target: TAIL },
        ],
      },
      { kind: 'left' },
    );
    expect(result.status).toBe('completed');
    const logs = await logsOf(executionId);
    expect(startedNodes(logs)).not.toContain(B);
    const output = outputOf(logs, MID);
    expect(output).toEqual({ echoed: { took: 'left' } });
  }, 60_000);
});
