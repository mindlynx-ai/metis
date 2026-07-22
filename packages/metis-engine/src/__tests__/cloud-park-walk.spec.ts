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
 * UPL-REQ-07 through a real Temporal walk: a cloud-routed node's dispatch
 * is accepted, the node parks (workflow.node.waiting with the job handle),
 * the heartbeated poll resumes the run with the cloud result, and
 * helixCancelSignal reaches the cloud job as a cancel call.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import {
  CapabilityGatewayClient,
  CapabilityResolver,
  CapturingEventSink,
  FakeCredentialPort,
  NodeHandlerRegistry,
  startHelixStub,
  type HelixStub,
} from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { createActivities } from '../activities/create-activities.js';
import type { HelixWorkflowInput } from '../types.js';

const TASK_QUEUE = 'metis-cloud-park-spec';
const START = 'node-71aaaaaa-1111-4222-8333-444444444444';
const DATA = 'node-72bbbbbb-1111-4222-8333-444444444444';

describe('cloud park and resume', () => {
  let env: TestWorkflowEnvironment;
  let stub: HelixStub;
  let store: WorkflowStore;
  let events: CapturingEventSink;
  let worker: Worker;
  let workerRun: Promise<void>;
  let executionCounter = 0;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    stub = await startHelixStub({ jobDelayMs: 3_000, entitled: ['cap.data'] });
    const dir = mkdtempSync(join(tmpdir(), 'metis-cloud-park-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'park.db')));
    registerWorkflowTables(gateway);
    store = new WorkflowStore(gateway);
    events = new CapturingEventSink();

    const gatewayClient = new CapabilityGatewayClient({
      baseUrl: stub.url,
      getBearer: async () => stub.issueToken(),
      timeoutMs: 5_000,
    });
    const registry = new NodeHandlerRegistry();
    registry.registerNodeHandler('data', () =>
      Promise.resolve({ status: 200, message: 'ok', nodeData: { data: { ranIn: 'local' } } }),
    );
    const resolver = new CapabilityResolver({
      local: registry,
      entryFor: (type) => (type === 'data' ? { execution: 'both', entitlement: 'cap.data' } : undefined),
      entitlements: async () => new Set(['cap.data']),
      gateway: gatewayClient,
      mode: 'park',
    });

    worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows', 'index.ts'),
      activities: createActivities({
        store,
        events,
        nodes: resolver,
        credentials: new FakeCredentialPort(),
        gateway: gatewayClient,
      }),
    });
    workerRun = worker.run();
  }, 180_000);

  afterAll(async () => {
    worker?.shutdown();
    await workerRun;
    await env?.teardown();
    await stub?.close();
  });

  const startCloudRun = async () => {
    executionCounter += 1;
    const executionId = `exec-cloud-${executionCounter}`;
    const input: HelixWorkflowInput = {
      tenantId: 't1',
      workflowId: 'wf-cloud-park',
      executionId,
      definition: {
        nodes: [
          { id: START, type: 'webhookconfig', config: {} },
          {
            id: DATA,
            type: 'data',
            config: { sql: 'select 1' },
            data: { metadata: { cloudRouting: { mode: 'cloud' } } },
          },
        ],
        edges: [{ source: START, target: DATA }],
        cloudRouting: { enabled: true, consentAt: '2026-07-18T09:00:00Z' },
      } as unknown as HelixWorkflowInput['definition'],
    };
    const handle = await env.client.workflow.start('helixWorkflow', {
      args: [input],
      workflowId: executionId,
      taskQueue: TASK_QUEUE,
    });
    return { executionId, handle };
  };

  const waitForWaitingLog = async (executionId: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const execution = await store.getExecution('t1', executionId);
      const waiting = execution?.logs.find((log) => log.event === 'workflow.node.waiting');
      if (waiting) return waiting;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`no waiting log appeared for ${executionId}`);
  };

  it('parks on the accepted job and resumes with the cloud result', async () => {
    const { executionId, handle } = await startCloudRun();
    const waiting = await waitForWaitingLog(executionId);
    expect(String(waiting.signalType)).toMatch(/^cloud-job:job_/);

    const result = (await handle.result()) as { status: string };
    expect(result.status).toBe('completed');

    const execution = await store.getExecution('t1', executionId);
    expect(execution?.meta.status).toBe('completed');
    expect(execution?.meta.degraded).toBeUndefined();
    const done = execution?.logs.find((log) => log.event === 'workflow.node.completed' && log.nodeId === DATA);
    expect(done?.binding).toBe('cloud');
    expect(done?.output).toMatchObject({ cloud: true, capability: 'data' });
  }, 120_000);

  it('helixCancelSignal cancels the run and the cancel reaches the cloud job', async () => {
    const { executionId, handle } = await startCloudRun();
    const waiting = await waitForWaitingLog(executionId);
    const jobId = String(waiting.signalType).replace('cloud-job:', '');

    await handle.signal('helixCancelSignal', { cancelledBy: 'jeremy' });
    const result = (await handle.result()) as { status: string };
    expect(result.status).toBe('cancelled');
    expect(stub.cancelled).toContain(jobId);
  }, 120_000);
});
