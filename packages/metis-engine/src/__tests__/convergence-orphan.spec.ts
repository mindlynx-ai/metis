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
 * A convergence node whose LIVE parent finished first.
 *
 * The orphan cascade asked "are all this node's sources finished?" - and a
 * Complete source counts as finished. So a join whose successful parent had
 * already completed read as dead as one whose parents were all orphaned, and
 * the answer depended on which side of the graph the walk reached first: the
 * same definition, the same input, a join that ran or did not run, and a run
 * reported COMPLETED either way.
 *
 * Tier A drives both orderings of one graph through the cascade itself.
 * Tier B runs the bad ordering as a real workflow, where the join's parent is
 * upstream of the switch and is therefore Complete by construction when the
 * losing branch is swept.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { CapturingEventSink, FakeCredentialPort, NodeHandlerRegistry } from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { createActivities } from '../activities/create-activities.js';
import { cascadeOrphan } from '../workflows/graph.js';
import type { HelixWorkflowInput, RuntimeNode, WorkflowEdge } from '../types.js';

const TASK_QUEUE = 'metis-convergence-spec';
const ROOT = 'node-60aaaaaa-1111-4222-8333-444444444444';
const PARENT = 'node-61bbbbbb-1111-4222-8333-444444444444';
const SWITCH = 'node-62cccccc-1111-4222-8333-444444444444';
const LOSER = 'node-63dddddd-1111-4222-8333-444444444444';
const JOIN = 'node-64eeeeee-1111-4222-8333-444444444444';
const LOSER_TWO = 'node-65ffffff-1111-4222-8333-444444444444';
const DEAD_JOIN = 'node-66aaaabb-1111-4222-8333-444444444444';

describe('tier A: the cascade predicate, driven at both orderings of one graph', () => {
  // ROOT->P, ROOT->SWITCH, SWITCH--false->X, X->J, P->J. J must always run:
  // P succeeded, so J has a live path whatever the walk reached first.
  const edges: WorkflowEdge[] = [
    { source: ROOT, target: PARENT },
    { source: ROOT, target: SWITCH },
    { source: SWITCH, target: LOSER, sourceHandle: 'source-default' },
    { source: LOSER, target: JOIN },
    { source: PARENT, target: JOIN },
  ];
  const graph = (parentStatus: RuntimeNode['nodeStatus']): RuntimeNode[] => [
    { id: ROOT, type: 'echo', nodeStatus: 'Complete' },
    { id: PARENT, type: 'echo', nodeStatus: parentStatus },
    { id: SWITCH, type: 'switch', nodeStatus: 'Complete' },
    { id: LOSER, type: 'echo', nodeStatus: 'Orphaned' },
    { id: JOIN, type: 'echo', nodeStatus: 'Pending' },
  ];

  it('spares the join when its live parent has already COMPLETED', () => {
    const nodes = graph('Complete');
    expect(cascadeOrphan(LOSER, nodes, edges)).toEqual([]);
    expect(nodes.find((node) => node.id === JOIN)?.nodeStatus).toBe('Pending');
  });

  it('spares the join when its live parent is still Pending (the ordering that always worked)', () => {
    const nodes = graph('Pending');
    expect(cascadeOrphan(LOSER, nodes, edges)).toEqual([]);
    expect(nodes.find((node) => node.id === JOIN)?.nodeStatus).toBe('Pending');
  });

  it('still orphans a join every one of whose parents is orphaned', () => {
    const nodes = graph('Orphaned');
    expect(cascadeOrphan(LOSER, nodes, edges)).toEqual([JOIN]);
    expect(nodes.find((node) => node.id === JOIN)?.nodeStatus).toBe('Orphaned');
  });

  it('a failed-but-continue parent is a live path too', () => {
    const nodes = graph('Failed');
    expect(cascadeOrphan(LOSER, nodes, edges)).toEqual([]);
  });
});

describe('tier B: the bad ordering as a real run', () => {
  let env: TestWorkflowEnvironment;
  let store: WorkflowStore;
  let worker: Worker;
  let workerRun: Promise<void>;
  let executionCounter = 0;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const dir = mkdtempSync(join(tmpdir(), 'metis-convergence-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'convergence.db')));
    registerWorkflowTables(gateway);
    store = new WorkflowStore(gateway);
    const nodes = new NodeHandlerRegistry();
    nodes.registerNodeHandler('echo', (ctx) =>
      Promise.resolve({
        status: 200,
        message: 'ok',
        nodeData: { data: { echoed: ctx.nodeRef.config } },
      }),
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

  /** Selects the `go-left` handle, which nothing is wired to: the default
   *  handle always loses, so the losing branch needs no input to steer it. */
  const switchNode = {
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
  };

  const run = async (definition: HelixWorkflowInput['definition']) => {
    executionCounter += 1;
    const executionId = `exec-convergence-${executionCounter}`;
    const result = (await env.client.workflow.execute('helixWorkflow', {
      args: [{ tenantId: 't1', workflowId: 'wf-convergence', executionId, definition, input: { kind: 'left' } }],
      workflowId: executionId,
      taskQueue: TASK_QUEUE,
    })) as { status: string };
    const execution = await store.getExecution('t1', executionId);
    const started = (execution?.logs ?? [])
      .filter((log) => log.event === 'workflow.node.started')
      .map((log) => log.nodeId);
    return { result, started };
  };

  it('dispatches the join when the switch sweeps its OTHER parent and this one already succeeded', async () => {
    // ROOT -> P -> SWITCH puts P Complete before the switch resolves, which is
    // the ordering that used to lose the join. P -> JOIN is the live path.
    const { result, started } = await run({
      nodes: [
        { id: ROOT, type: 'echo', config: { step: 'root' } },
        { id: PARENT, type: 'echo', config: { step: 'parent' } },
        switchNode,
        { id: LOSER, type: 'echo', config: { step: 'loser' } },
        { id: JOIN, type: 'echo', config: { step: 'join' } },
      ],
      edges: [
        { source: ROOT, target: PARENT },
        { source: PARENT, target: SWITCH },
        { source: SWITCH, target: LOSER, sourceHandle: 'source-default' },
        { source: LOSER, target: JOIN },
        { source: PARENT, target: JOIN },
      ],
    });
    expect(result.status).toBe('completed');
    expect(started).not.toContain(LOSER);
    expect(started).toContain(JOIN);
    expect(started.filter((id) => id === JOIN)).toHaveLength(1);
  }, 60_000);

  it('still orphans a join reachable only through swept branches', async () => {
    const { result, started } = await run({
      nodes: [
        switchNode,
        { id: LOSER, type: 'echo', config: { step: 'loser' } },
        { id: LOSER_TWO, type: 'echo', config: { step: 'loser-two' } },
        { id: DEAD_JOIN, type: 'echo', config: { step: 'dead-join' } },
      ],
      edges: [
        { source: SWITCH, target: LOSER, sourceHandle: 'source-default' },
        { source: SWITCH, target: LOSER_TWO, sourceHandle: 'source-default' },
        { source: LOSER, target: DEAD_JOIN },
        { source: LOSER_TWO, target: DEAD_JOIN },
      ],
    });
    expect(result.status).toBe('completed');
    expect(started).not.toContain(DEAD_JOIN);
  }, 60_000);
});
