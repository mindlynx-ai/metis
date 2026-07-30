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
 * What Temporal's own retry does to a node that talks to the outside world.
 *
 * The default policy is unlimited attempts, so an activity that threw (or
 * outran its budget) after the handler had already posted its request sent that
 * request again, for ever. Worse, the log hid it: the sequence is deterministic
 * from workflow history, so every attempt wrote the SAME sort key and upserted
 * over its predecessor, leaving a run that looked like one attempt of one node.
 *
 * These run the real workflow through a time-skipping Temporal environment,
 * with a store that fails the way a store fails: after the dispatch.
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
  type ExecutionLogItem,
} from '@mindlynx/metis-data-gateway';
import { createActivities } from '../activities/create-activities.js';
import { ENGINE_ACTIVITY_RETRY, type HelixWorkflowInput } from '../types.js';

const NODE_SEND = 'node-11111111-1111-4222-8333-444444444444';
/** A secret id that is not in the vault: the shape the resolver refuses. */
const MISSING_SECRET = '{{secrets.99999999-1111-4222-8333-444444444444}}';

/**
 * A store that throws on a node's TERMINAL log row, which is the honest shape
 * of the failure: the started row is written, the handler has already run and
 * done its side effect, and only then does the write fail. `failures` bounds how
 * many attempts fail, so one harness covers "recovers on the next attempt" and
 * "never recovers".
 */
class LateFailingStore extends WorkflowStore {
  failuresLeft = 0;

  override async appendExecutionLog(log: ExecutionLogItem): Promise<void> {
    const isTerminal = log.sequence % 10 === 2;
    if (isTerminal && this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error('the store refused the write');
    }
    return super.appendExecutionLog(log);
  }
}

describe('bounded activity retry, and a retried attempt that shows on the run', () => {
  let env: TestWorkflowEnvironment;
  let store: LateFailingStore;
  let worker: Worker;
  let workerRun: Promise<void>;
  let sends = 0;
  let executionCounter = 0;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const dir = mkdtempSync(join(tmpdir(), 'metis-retry-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'retry.db')));
    registerWorkflowTables(gateway);
    store = new LateFailingStore(gateway);
    const nodes = new NodeHandlerRegistry();
    // Stands in for any handler with a side effect: it counts the times the
    // outside world was touched, which is the number the retry policy bounds.
    nodes.registerNodeHandler('sender', () => {
      sends += 1;
      return Promise.resolve({ status: 200, message: 'ok', nodeData: { data: { sent: true } } });
    });
    worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'metis-retry-spec',
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

  const run = async (config: Record<string, unknown> = {}) => {
    executionCounter += 1;
    const executionId = `exec-retry-${executionCounter}`;
    const definition: HelixWorkflowInput['definition'] = {
      nodes: [{ id: NODE_SEND, type: 'sender', config }],
      edges: [],
    };
    const result = (await env.client.workflow.execute('helixWorkflow', {
      args: [{ tenantId: 't1', workflowId: 'wf-retry', executionId, definition }],
      workflowId: executionId,
      taskQueue: 'metis-retry-spec',
    })) as { status: string };
    return { executionId, result };
  };

  const logsFor = async (executionId: string): Promise<ExecutionLogItem[]> =>
    (await store.getExecution('t1', executionId))?.logs ?? [];

  it('stops at the configured attempt count instead of retrying for ever', async () => {
    sends = 0;
    store.failuresLeft = Number.MAX_SAFE_INTEGER;
    const { result } = await run();
    expect(result.status).toBe('failed');
    // The whole point: a node that dispatches on every attempt dispatches
    // exactly maximumAttempts times, not without end.
    expect(sends).toBe(ENGINE_ACTIVITY_RETRY.maximumAttempts);
    store.failuresLeft = 0;
  });

  it('a second attempt is a second row, not an overwrite of the first', async () => {
    sends = 0;
    store.failuresLeft = 1;
    const { executionId, result } = await run();
    expect(result.status).toBe('completed');
    // Two dispatches happened, so the run has to say two dispatches happened.
    expect(sends).toBe(2);
    const started = (await logsFor(executionId)).filter(
      (log) => log.event === 'workflow.node.started' && log.nodeId === NODE_SEND,
    );
    expect(started).toHaveLength(2);
    expect(started.map((log) => log.activityAttempt)).toEqual([1, 2]);
    // Same sequence, different sort key: the upsert that used to hide the
    // second attempt has nothing left to overwrite.
    expect(new Set(started.map((log) => log.sequence)).size).toBe(1);
    expect(new Set(started.map((log) => log.SK)).size).toBe(2);
  });

  it('a secret that is not in the vault is refused once, not three times', async () => {
    sends = 0;
    store.failuresLeft = 0;
    const { executionId, result } = await run({ apiKey: MISSING_SECRET });
    expect(result.status).toBe('failed');
    // Resolution happens before dispatch, so nothing was sent; the assertion
    // that matters is that Temporal did not come back for a second look.
    expect(sends).toBe(0);
    const started = (await logsFor(executionId)).filter(
      (log) => log.event === 'workflow.node.started' && log.nodeId === NODE_SEND,
    );
    expect(started).toHaveLength(1);
  });
});
