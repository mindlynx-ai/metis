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
 * The paid half of the edition proof: with the pack registered on the open
 * registry (the plugin seam), an approval step really does park a run, take
 * the decided branch, and leave an audit line on the run's own log.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { createActivities, type HelixWorkflowInput } from '@mindlynx/metis-engine';
import { registerApprovalNodes } from '../approval-node.js';
import { approvalSignalType } from '../approval-decision.js';

const TASK_QUEUE = 'metis-approvals-spec';
const GATE = 'node-a1aaaaaa-1111-4222-8333-444444444444';
const PAY = 'node-a2bbbbbb-1111-4222-8333-444444444444';
const DECLINE = 'node-a3cccccc-1111-4222-8333-444444444444';

/** A gate with both branches wired: pay on approved, decline on rejected. */
const definition = (config: Record<string, unknown>): HelixWorkflowInput['definition'] => ({
  nodes: [
    { id: GATE, type: 'approval', config: { title: 'Refund order 4182', ...config } },
    { id: PAY, type: 'record', config: { did: 'paid' } },
    { id: DECLINE, type: 'record', config: { did: 'declined' } },
  ],
  edges: [
    { source: GATE, target: PAY, sourceHandle: 'approved' },
    { source: GATE, target: DECLINE, sourceHandle: 'rejected' },
  ],
});

describe('an approval step in a real run', () => {
  let env: TestWorkflowEnvironment;
  let store: WorkflowStore;
  let events: CapturingEventSink;
  let worker: Worker;
  let workerRun: Promise<void>;
  let counter = 0;
  const recorded: Record<string, unknown>[] = [];

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const dir = mkdtempSync(join(tmpdir(), 'metis-approvals-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'approvals.db')));
    registerWorkflowTables(gateway);
    store = new WorkflowStore(gateway);
    events = new CapturingEventSink();
    const nodes = new NodeHandlerRegistry();
    nodes.registerNodeHandler('record', (ctx) => {
      recorded.push(ctx.nodeRef.config);
      return Promise.resolve({ status: 200, message: 'ok', nodeData: { data: ctx.nodeRef.config } });
    });
    // The plugin seam: the paid pack registers itself, nothing imports it.
    registerApprovalNodes(nodes);
    worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: fileURLToPath(
        new URL('../../../metis-engine/src/workflows/index.ts', import.meta.url),
      ),
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

  const start = async (config: Record<string, unknown>) => {
    counter += 1;
    const executionId = `exec-approval-${counter}`;
    const handle = await env.client.workflow.start('helixWorkflow', {
      args: [{ tenantId: 't1', workflowId: 'wf-approvals', executionId, definition: definition(config) }],
      workflowId: executionId,
      taskQueue: TASK_QUEUE,
    });
    return { executionId, handle };
  };

  /** Wait until the run has actually parked, so a signal cannot race it. */
  const untilParked = async (executionId: string) => {
    const deadline = Date.now() + 30_000;
    while (
      !events.events.some(
        (event) => event.executionId === executionId && event.name === 'workflow.node.waiting',
      )
    ) {
      if (Date.now() > deadline) throw new Error('the run never parked on the approval');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  it('parks the run with the request a reviewer decides on', async () => {
    const { executionId } = await start({ summary: { Amount: '4182.50' } });
    await untilParked(executionId);
    const parked = events.events.find(
      (event) => event.executionId === executionId && event.name === 'workflow.node.waiting',
    );
    expect(parked?.nodeId).toBe(GATE);
    expect(parked?.payload?.signalType).toBe(approvalSignalType(GATE));
    // The request rides the waiting line, so a queue can show it from the
    // run list alone.
    expect(parked?.payload?.details).toMatchObject({
      kind: 'approval',
      title: 'Refund order 4182',
      fields: [{ label: 'Amount', value: '4182.50' }],
    });
  }, 60_000);

  it('takes the approved branch and records who signed it off', async () => {
    const { executionId, handle } = await start({});
    await untilParked(executionId);
    await handle.signal('helixSignal', {
      signalType: approvalSignalType(GATE),
      // As the signal route stamps it: the identity is the server's, not the
      // caller's claim.
      signalParams: {
        decision: 'approved',
        reason: 'invoice checked',
        signalledBy: 'jeremy',
        signalledByRole: 'admin',
      },
    });
    expect(((await handle.result()) as { status: string }).status).toBe('completed');
    expect(recorded).toContainEqual({ did: 'paid' });

    const execution = await store.getExecution('t1', executionId);
    const decided = execution?.logs.find(
      (log) => log.nodeId === GATE && log.event === 'workflow.node.completed',
    );
    // The log IS the audit trail: who, what, why and when.
    expect(decided?.output).toMatchObject({
      decision: 'approved',
      approver: 'jeremy',
      approverRole: 'admin',
      reason: 'invoice checked',
    });
    expect(Number.isNaN(Date.parse(String((decided?.output as { at: string }).at)))).toBe(false);
    // The losing branch never ran.
    expect(
      execution?.logs.some((log) => log.nodeId === DECLINE && log.event === 'workflow.node.started'),
    ).toBe(false);
  }, 60_000);

  it('rejects on the branch, and the paid step never ran below it', async () => {
    const { executionId, handle } = await start({});
    await untilParked(executionId);
    await handle.signal('helixSignal', {
      signalType: approvalSignalType(GATE),
      signalParams: {
        decision: 'rejected',
        reason: 'duplicate claim',
        signalledBy: 'jeremy',
        signalledByRole: 'admin',
      },
    });
    expect(((await handle.result()) as { status: string }).status).toBe('completed');
    expect(recorded).toContainEqual({ did: 'declined' });
    const execution = await store.getExecution('t1', executionId);
    expect(
      execution?.logs.some((log) => log.nodeId === PAY && log.event === 'workflow.node.started'),
    ).toBe(false);
  }, 60_000);

  it('an SLA that runs out rejects, and says nobody decided it', async () => {
    // Time skips forward past the deadline with nobody answering.
    const { executionId, handle } = await start({ slaHours: 4 });
    expect(((await handle.result()) as { status: string }).status).toBe('completed');
    expect(recorded).toContainEqual({ did: 'declined' });
    const execution = await store.getExecution('t1', executionId);
    const decided = execution?.logs.find(
      (log) => log.nodeId === GATE && log.event === 'workflow.node.completed',
    );
    expect(decided?.output).toMatchObject({ decision: 'rejected', expired: true });
    expect(decided?.output).not.toHaveProperty('approver');
  }, 60_000);

  it('escalates once before rejecting, so the queue can shout first', async () => {
    const { executionId, handle } = await start({ slaHours: 1, onExpiry: 'escalate' });
    expect(((await handle.result()) as { status: string }).status).toBe('completed');
    const execution = await store.getExecution('t1', executionId);
    const parks = execution!.logs.filter(
      (log) => log.nodeId === GATE && log.event === 'workflow.node.waiting',
    );
    expect(parks).toHaveLength(2);
    expect(parks[1]?.details).toMatchObject({ escalated: true });
    const decided = execution?.logs.find(
      (log) => log.nodeId === GATE && log.event === 'workflow.node.completed',
    );
    expect(decided?.output).toMatchObject({ decision: 'rejected', expired: true, escalated: true });
  }, 60_000);

  it('stops the run when the step says an expiry must not pass unnoticed', async () => {
    const { executionId, handle } = await start({ slaHours: 1, onExpiry: 'fail' });
    expect(((await handle.result()) as { status: string }).status).toBe('failed');
    const execution = await store.getExecution('t1', executionId);
    expect(String(execution?.meta.failureReason ?? '')).toMatch(/nobody decided/i);
  }, 60_000);
});
