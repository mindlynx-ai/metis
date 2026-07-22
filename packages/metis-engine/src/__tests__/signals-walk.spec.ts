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

const TASK_QUEUE = 'metis-signals-spec';
const SIG = 'node-61aaaaaa-1111-4222-8333-444444444444';
const AFTER = 'node-62bbbbbb-1111-4222-8333-444444444444';
const WAIT = 'node-63cccccc-1111-4222-8333-444444444444';

describe('signals and waituntil', () => {
  let env: TestWorkflowEnvironment;
  let store: WorkflowStore;
  let events: CapturingEventSink;
  let worker: Worker;
  let workerRun: Promise<void>;
  let executionCounter = 0;
  const recordedConfigs: Record<string, unknown>[] = [];

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const dir = mkdtempSync(join(tmpdir(), 'metis-signals-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'signals.db')));
    registerWorkflowTables(gateway);
    store = new WorkflowStore(gateway);
    events = new CapturingEventSink();
    const nodes = new NodeHandlerRegistry();
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

  const startWorkflow = async (
    definition: HelixWorkflowInput['definition'],
    inputPayload?: Record<string, unknown>,
  ) => {
    executionCounter += 1;
    const executionId = `exec-signal-${executionCounter}`;
    const input: HelixWorkflowInput = {
      tenantId: 't1',
      workflowId: 'wf-signals',
      executionId,
      definition,
      input: inputPayload,
    };
    const handle = await env.client.workflow.start('helixWorkflow', {
      args: [input],
      workflowId: executionId,
      taskQueue: TASK_QUEUE,
    });
    return { executionId, handle };
  };

  it('parks a signal node and resumes on helixSignal, exposing signal params downstream', async () => {
    const { executionId, handle } = await startWorkflow(
      {
        nodes: [
          { id: SIG, type: 'signal', config: { signalType: 'approval' } },
          { id: AFTER, type: 'record', config: { got: `{{${SIG}.data.decision}}` } },
        ],
        edges: [{ source: SIG, target: AFTER }],
      },
      undefined,
    );
    await handle.signal('helixSignal', {
      signalType: 'approval',
      signalParams: { decision: 'approved' },
    });
    const result = (await handle.result()) as { status: string };
    expect(result.status).toBe('completed');

    const execution = await store.getExecution('t1', executionId);
    expect(execution?.meta.status).toBe('completed');
    const waitingEvent = events.events.find(
      (event) => event.name === 'workflow.node.waiting' && event.executionId === executionId,
    );
    expect(waitingEvent?.nodeId).toBe(SIG);
    const signalEvent = events.events.find(
      (event) => event.name === 'workflow.signal.received' && event.executionId === executionId,
    );
    expect(signalEvent).toBeDefined();
    expect(recordedConfigs).toContainEqual({ got: 'approved' });
  }, 60_000);

  it('times out a parked signal after the 24 hour default and fails the run', async () => {
    const { executionId, handle } = await startWorkflow({
      nodes: [
        { id: SIG, type: 'signal', config: { signalType: 'never-comes' } },
        { id: AFTER, type: 'record', config: {} },
      ],
      edges: [{ source: SIG, target: AFTER }],
    });
    const result = (await handle.result()) as { status: string };
    expect(result.status).toBe('failed');
    const execution = await store.getExecution('t1', executionId);
    expect(execution?.meta.status).toBe('failed');
    expect(String(execution?.meta.failureReason ?? '')).toMatch(/timed out/i);
  }, 60_000);

  it('helixCancelSignal completes the run with status cancelled and marks nodes cancelled', async () => {
    const { executionId, handle } = await startWorkflow({
      nodes: [
        { id: SIG, type: 'signal', config: { signalType: 'blocked' } },
        { id: AFTER, type: 'record', config: {} },
      ],
      edges: [{ source: SIG, target: AFTER }],
    });
    await handle.signal('helixCancelSignal', { cancelledBy: 'jeremy', reason: 'changed my mind' });
    const result = (await handle.result()) as { status: string };
    expect(result.status).toBe('cancelled');
    const execution = await store.getExecution('t1', executionId);
    expect(execution?.meta.status).toBe('cancelled');
    const cancelledEvent = events.events.find(
      (event) => event.name === 'workflow.execution.cancelled' && event.executionId === executionId,
    );
    expect(cancelledEvent).toBeDefined();
  }, 60_000);

  it('auto-resumes a manual entry signal using the run input as signal params', async () => {
    const { handle } = await startWorkflow(
      {
        nodes: [
          { id: SIG, type: 'signal', config: { signalType: 'manual' } },
          { id: AFTER, type: 'record', config: { seeded: `{{${SIG}.data.name}}` } },
        ],
        edges: [{ source: SIG, target: AFTER }],
      },
      { name: 'from-run-input' },
    );
    const result = (await handle.result()) as { status: string };
    expect(result.status).toBe('completed');
    expect(recordedConfigs).toContainEqual({ seeded: 'from-run-input' });
  }, 60_000);

  it('waituntil sleeps the configured duration and the walk continues', async () => {
    const { executionId, handle } = await startWorkflow({
      nodes: [
        { id: WAIT, type: 'waituntil', config: { waitMinutes: 90 } },
        { id: AFTER, type: 'record', config: { after: 'the-wait' } },
      ],
      edges: [{ source: WAIT, target: AFTER }],
    });
    const result = (await handle.result()) as { status: string };
    expect(result.status).toBe('completed');
    expect(recordedConfigs).toContainEqual({ after: 'the-wait' });
    const execution = await store.getExecution('t1', executionId);
    const waitCompleted = execution?.logs.find(
      (log) => log.nodeId === WAIT && log.event === 'workflow.node.completed',
    );
    expect(waitCompleted).toBeDefined();
    // The park is LOGGED with its wake time, so Operate can say where the run
    // is ("waiting until ...") while it sleeps - not just that it is running.
    const parked = execution?.logs.find(
      (log) => log.nodeId === WAIT && log.event === 'workflow.node.waiting',
    );
    expect(parked).toBeDefined();
    expect(typeof parked?.until).toBe('string');
    expect(Number.isNaN(Date.parse(String(parked?.until)))).toBe(false);
  }, 60_000);

  it('helixCancelSignal interrupts a waituntil sleep instead of waiting out the timer', async () => {
    const { executionId, handle } = await startWorkflow({
      nodes: [
        { id: WAIT, type: 'waituntil', config: { waitDays: 30 } },
        { id: AFTER, type: 'record', config: {} },
      ],
      edges: [{ source: WAIT, target: AFTER }],
    });
    // Let the run genuinely park on the 30-day timer before cancelling -
    // a cancel that lands first never reaches the wait at all.
    const deadline = Date.now() + 30_000;
    while (
      !events.events.some(
        (event) => event.executionId === executionId && event.name === 'workflow.node.waiting',
      )
    ) {
      if (Date.now() > deadline) throw new Error('run never parked on the waituntil timer');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await handle.signal('helixCancelSignal', { cancelledBy: 'jeremy', reason: 'no need' });
    const result = (await handle.result()) as { status: string };
    expect(result.status).toBe('cancelled');
    // The park must end on the CANCEL, not the timer: a plain sleep would show
    // the 30-day timer FIRING in history before the run closed. The
    // interruptible condition cancels the timer instead.
    const history = await handle.fetchHistory();
    const timersFired = (history.events ?? []).filter((event) => event.timerFiredEventAttributes);
    expect(timersFired).toHaveLength(0);
    const execution = await store.getExecution('t1', executionId);
    expect(execution?.meta.status).toBe('cancelled');
  }, 60_000);
});
