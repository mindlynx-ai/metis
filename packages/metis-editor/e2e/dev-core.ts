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
 * The editor e2e control plane: metis-core on 4181 with a throwaway
 * SQLite store and one admin user (jeremy / pw). Started by the
 * Playwright webServer array beside the Vite dev server.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SingleTenantIdentity } from '../../metis-ports/src/adapters/single-tenant-identity.js';
import { DataGateway } from '../../metis-data-gateway/src/gateway.js';
import { SqliteAdapter } from '../../metis-data-gateway/src/sqlite-adapter.js';
import { WorkflowStore, registerWorkflowTables } from '../../metis-data-gateway/src/workflow-store.js';
import { buildCoreServer } from '../../metis-core/src/server.js';
import { LocalEventBus } from '../../metis-ports/src/adapters/local-event-bus.js';
import { FakeCredentialPort } from '../../metis-ports/src/fakes.js';
import { DefaultConnectionTester } from '../../metis-nodes/src/connection-tester.js';
import { attachSocketHub } from '../../metis-orchestrator/src/socket-hub.js';
import type { WorkflowEventName } from '../../metis-ports/src/event-sink.js';
import { FakeExecutionPort } from '../../metis-ports/src/fakes.js';
import type { TemporalExecutionSummary } from '../../metis-ports/src/execution-port.js';
import { startHelixStub, type HelixStub } from '../../metis-ports/src/adapters/helix-stub.js';
import {
  CloudEntitlementsClient,
  OffersClient,
  helixAccountBearer,
} from '../../metis-ports/src/uplift.js';

const dir = mkdtempSync(join(tmpdir(), 'metis-editor-e2e-'));
const gateway = new DataGateway(new SqliteAdapter(join(dir, 'editor-e2e.db')));
registerWorkflowTables(gateway);
const store = new WorkflowStore(gateway);

const identity = await SingleTenantIdentity.create('t1', [
  { userId: 'jeremy', secret: 'pw', role: 'admin' },
  { userId: 'watcher', secret: 'pw', role: 'viewer' },
]);

// The Helix stub (offers/entitlements/gateway/OIDC) on a fixed port so the
// fast suite exercises the real uplift surfaces; /e2e/helix-stub can stop
// and restart it to prove the offline static fallback.
const HELIX_STUB_PORT = 4182;
const HELIX_STUB_URL = `http://127.0.0.1:${HELIX_STUB_PORT}`;
let helixStub: HelixStub | undefined = await startHelixStub({}, HELIX_STUB_PORT);
const credentials = new FakeCredentialPort();
// Zero TTLs: the suite flips the stub up/down and every read must be live.
const getBearer = helixAccountBearer(credentials, 't1', {
  identityUrl: HELIX_STUB_URL,
  clientId: 'metis',
});
const uplift = {
  offers: new OffersClient({ baseUrl: HELIX_STUB_URL, ttlMs: 0 }),
  entitlements: new CloudEntitlementsClient({ baseUrl: HELIX_STUB_URL, getBearer, ttlMs: 0 }),
  credentials,
  identityUrl: HELIX_STUB_URL,
  redirectBase: 'http://127.0.0.1:4180',
};

/** The Helix-shaped node the editor saves (config/label under data). */
interface SavedNode {
  id: string;
  type: string;
  data?: { label?: string; config?: Record<string, unknown> };
}

// A visibility-capable execution port so /api/executions/temporal registers,
// with a tiny simulated engine behind start(): each node in the submitted
// definition gets a completed log (a step named "Fail me" fails instead), so
// the inspector's Test/History tabs and the builder Run button are real in
// the harness without a Temporal server. workflowId IS the Metis executionId
// (the temporal adapter's convention).
class StubExecutionPort extends FakeExecutionPort {
  // Mission-control surface for the Operate page e2e.
  countByStatus(): Promise<Record<string, number>> {
    return Promise.resolve({ running: 1, completed: 7, failed: 1, terminated: 0 });
  }

  taskQueueHealth(): Promise<{
    taskQueue: string;
    pollers: { identity: string; lastAccessTime?: string }[];
    backlogCount?: number;
    backlogAgeSeconds?: number;
  }> {
    return Promise.resolve({
      taskQueue: 'metis-workflow-tasks',
      pollers: [{ identity: 'worker@dev-harness', lastAccessTime: new Date().toISOString() }],
      backlogCount: 3,
      backlogAgeSeconds: 12,
    });
  }

  terminate(): Promise<void> {
    return Promise.resolve();
  }

  // Seeded runs were never started through the fake; signalling them is fine.
  signal(): Promise<void> {
    return Promise.resolve();
  }

  describe(executionId: string): Promise<Record<string, unknown>> {
    // The seeded running run retries a flaky step; children have a parent.
    if (executionId === 'exec_seeded_running') {
      return Promise.resolve({
        executionId,
        pendingActivities: [
          { type: 'executeNode', attempt: 4, maximumAttempts: 10, lastFailure: 'connect ETIMEDOUT' },
        ],
      });
    }
    if (executionId.startsWith('exec_seeded_1-loop-')) {
      return Promise.resolve({ executionId, parentExecutionId: 'exec_seeded_1', pendingActivities: [] });
    }
    return Promise.resolve({ executionId, pendingActivities: [] });
  }

  reset(): Promise<{ runId: string }> {
    return Promise.resolve({ runId: 'run-after-reset' });
  }

  list(query?: { limit?: number; query?: string }): Promise<TemporalExecutionSummary[]> {
    // Child runs (loop iterations) hang off exec_seeded_1.
    const parentMatch = /ParentWorkflowId="([^"]+)"/.exec(query?.query ?? '');
    if (parentMatch) {
      if (parentMatch[1] !== 'exec_seeded_1') return Promise.resolve([]);
      return Promise.resolve([
        {
          workflowId: 'exec_seeded_1-loop-node-0',
          runId: 'run-child-0',
          type: 'helixWorkflow',
          status: 'completed',
          startTime: '2026-07-03T11:58:00.500Z',
          closeTime: '2026-07-03T11:58:00.900Z',
          taskQueue: 'metis-workflow-tasks',
        },
        {
          workflowId: 'exec_seeded_1-loop-node-1',
          runId: 'run-child-1',
          type: 'helixWorkflow',
          status: 'completed',
          startTime: '2026-07-03T11:58:01.000Z',
          closeTime: '2026-07-03T11:58:01.400Z',
          taskQueue: 'metis-workflow-tasks',
        },
      ]);
    }
    const all: TemporalExecutionSummary[] = [
      {
        workflowId: 'exec_seeded_running',
        runId: 'run-seeded-0',
        type: 'helixWorkflow',
        status: 'running',
        startTime: '2026-07-03T12:20:00.000Z',
        historyLength: 4,
        taskQueue: 'metis-workflow-tasks',
      },
      {
        workflowId: 'exec_seeded_1',
        runId: 'run-seeded-1',
        type: 'helixWorkflow',
        status: 'completed',
        startTime: '2026-07-03T11:58:00.000Z',
        closeTime: '2026-07-03T11:58:02.000Z',
        historyLength: 12,
        taskQueue: 'metis-workflow-tasks',
      },
      {
        workflowId: 'exec_seeded_failed',
        runId: 'run-seeded-2',
        type: 'helixWorkflow',
        status: 'failed',
        startTime: '2026-07-03T12:10:00.000Z',
        closeTime: '2026-07-03T12:10:05.000Z',
        historyLength: 9,
        taskQueue: 'metis-workflow-tasks',
      },
    ];
    const wanted = /ExecutionStatus="(\w+)"/.exec(query?.query ?? '')?.[1]?.toLowerCase();
    return Promise.resolve(wanted ? all.filter((item) => item.status === wanted) : all);
  }

  async start(request: Parameters<FakeExecutionPort['start']>[0]) {
    const { executionId, workflowId } = request;
    const definition = (request as { definition?: { nodes?: SavedNode[] } }).definition;
    await store.writeExecutionMeta({
      tenantId: 't1',
      executionId,
      workflowId,
      status: 'running',
      startTime: new Date().toISOString(),
    });
    let sequence = 0;
    let failed = false;
    for (const node of definition?.nodes ?? []) {
      sequence += 1;
      const boom = node.data?.label === 'Fail me';
      await store.appendExecutionLog({
        tenantId: 't1',
        executionId,
        sequence: sequence * 10 + 2,
        nodeId: node.id,
        nodeType: node.type,
        event: boom ? 'workflow.node.failed' : 'workflow.node.completed',
        outcome: boom ? 'failed' : 'completed',
        output: boom ? undefined : { simulated: true, echo: node.data?.config ?? {} },
        error: boom ? { message: 'simulated failure' } : undefined,
        attempts: boom ? 2 : undefined,
        at: new Date().toISOString(),
      });
      if (boom) {
        failed = true;
        break;
      }
    }
    await store.updateExecutionMeta('t1', executionId, {
      status: failed ? 'failed' : 'completed',
      endTime: new Date().toISOString(),
      ...(failed ? { failureReason: 'simulated failure' } : {}),
    });
    return super.start(request);
  }

  // A simulated synchronous api run: echo the request body back and honour the
  // API End statusCode, so the ingress round-trip is exercised without a real
  // Temporal server. The real engine's response logic is covered by unit tests.
  async startApiAndWait(request: Parameters<FakeExecutionPort['start']>[0]) {
    const definition = (request as { definition?: { nodes?: SavedNode[] } }).definition;
    const apiEnd = (definition?.nodes ?? []).find((node) => node.type === 'apiend');
    const statusCode = Number(apiEnd?.data?.config?.statusCode) || 200;
    const input = (request as { input?: unknown }).input ?? {};
    return {
      executionId: request.executionId,
      status: 'completed' as const,
      response: { ok: true, received: input },
      statusCode,
    };
  }
}

const app = buildCoreServer({
  identity,
  store,
  credentials,
  uplift,
  schedules: {
    describeAll: () =>
      Promise.resolve([
        {
          scheduleId: 'sch_t1_wf-daily',
          workflowId: 'wf-daily',
          workflowName: 'Daily digest',
          paused: false,
          cron: '0 9 * * *',
          nextRun: '2026-07-11T09:00:00.000Z',
          nextRuns: ['2026-07-11T09:00:00.000Z', '2026-07-12T09:00:00.000Z'],
        },
      ]),
    pause: () => Promise.resolve(),
    unpause: () => Promise.resolve(),
  },
  connectionTester: new DefaultConnectionTester(),
  executions: new StubExecutionPort(),
});

// Seeded history for the run viewer specs.
await store.writeExecutionMeta({
  tenantId: 't1',
  executionId: 'exec_seeded_1',
  workflowId: 'wf-runs-demo',
  status: 'completed',
  startTime: '2026-07-03T11:58:00.000Z',
  endTime: '2026-07-03T11:58:02.000Z',
  definitionVersion: 1,
  definitionChangeset: 0,
});
await store.appendExecutionLog({
  tenantId: 't1',
  executionId: 'exec_seeded_1',
  sequence: 11,
  nodeId: 'node-demo-a',
  nodeType: 'webhookconfig',
  event: 'workflow.node.completed',
  at: '2026-07-03T11:58:00.400Z',
});
await store.appendExecutionLog({
  tenantId: 't1',
  executionId: 'exec_seeded_1',
  sequence: 21,
  nodeId: 'node-demo-b',
  nodeType: 'api',
  event: 'workflow.node.completed',
  at: '2026-07-03T11:58:01.100Z',
});

await store.appendExecutionLog({
  tenantId: 't1',
  executionId: 'exec_seeded_1',
  sequence: 33,
  nodeIds: ['node-wait'],
  event: 'workflow.node.orphaned',
  at: '2026-07-03T11:58:01.200Z',
});

// A FAILED run with an error and a retried step: failure rendering must be
// legible ("history working 100%" includes what went wrong).
await store.writeExecutionMeta({
  tenantId: 't1',
  executionId: 'exec_seeded_failed',
  workflowId: 'wf-runs-demo',
  status: 'failed',
  startTime: '2026-07-03T12:10:00.000Z',
  endTime: '2026-07-03T12:10:05.000Z',
  failureReason: 'upstream returned 500',
});
await store.appendExecutionLog({
  tenantId: 't1',
  executionId: 'exec_seeded_failed',
  sequence: 11,
  nodeId: 'node-fails',
  nodeType: 'api',
  event: 'workflow.node.failed',
  outcome: 'failed',
  error: { message: 'upstream returned 500' },
  attempts: 3,
  at: '2026-07-03T12:10:04.500Z',
});

// The running run is PARKED on a signal (human-in-the-loop): the board's
// whereabouts enrichment derives "waiting - signal: approval" from these rows.
await store.putWorkflowVersion({
  tenantId: 't1',
  workflowId: 'wf-runs-demo',
  version: 1,
  changeset: 0,
  status: 'published',
  name: 'Order approvals',
  type: 'workflow',
  definition: {
    nodes: [
      { id: 'node-demo-a', type: 'webhookconfig', version: 'v1', data: { label: 'Webhook start', config: {} } },
      { id: 'node-wait', type: 'signal', version: 'v1', data: { label: 'Await approval', config: {} } },
    ],
    edges: [{ id: 'e1', source: 'node-demo-a', target: 'node-wait', sourceHandle: null }],
  },
});
await store.writeExecutionMeta({
  tenantId: 't1',
  executionId: 'exec_seeded_running',
  workflowId: 'wf-runs-demo',
  status: 'running',
  startTime: '2026-07-03T12:20:00.000Z',
});
await store.appendExecutionLog({
  tenantId: 't1',
  executionId: 'exec_seeded_running',
  sequence: 11,
  nodeId: 'node-wait',
  nodeType: 'signal',
  event: 'workflow.node.waiting',
  signalType: 'approval',
  at: '2026-07-03T12:20:01.000Z',
});

// A run Temporal has FORGOTTEN (absent from the stub list): the Archive.
await store.writeExecutionMeta({
  tenantId: 't1',
  executionId: 'exec_seeded_ancient',
  workflowId: 'wf-runs-demo',
  status: 'completed',
  startTime: '2026-05-01T09:00:00.000Z',
  endTime: '2026-05-01T09:00:03.000Z',
  definitionVersion: 1,
  definitionChangeset: 0,
});
await store.appendExecutionLog({
  tenantId: 't1',
  executionId: 'exec_seeded_ancient',
  sequence: 11,
  nodeId: 'node-demo-a',
  nodeType: 'webhookconfig',
  event: 'workflow.node.completed',
  at: '2026-05-01T09:00:01.000Z',
});

// A DEGRADED run: cloud was chosen, the gateway was unreachable, the step
// ran here instead - the run itself still completed (degraded is a
// modifier, never a failure). Feeds the banner/badge/row-icon/receipt UI.
await store.putWorkflowVersion({
  tenantId: 't1',
  workflowId: 'wf-degraded-demo',
  version: 1,
  changeset: 0,
  status: 'published',
  name: 'Invoice chaser',
  type: 'workflow',
  definition: {
    nodes: [
      {
        id: 'node-deg-start',
        type: 'webhookconfig',
        version: 'v1',
        data: { label: 'Webhook Start', config: {} },
        position: { x: 80, y: 120 },
      },
      {
        id: 'node-deg-data',
        type: 'data',
        version: 'v1',
        data: {
          label: 'Data',
          config: {},
          metadata: { cloudRouting: { mode: 'cloud' } },
        },
        position: { x: 400, y: 120 },
      },
    ],
    edges: [{ id: 'e-deg-1', source: 'node-deg-start', target: 'node-deg-data', sourceHandle: null }],
    cloudRouting: { enabled: true, consentAt: '2026-07-14T09:00:00.000Z' },
  },
});
await store.writeExecutionMeta({
  tenantId: 't1',
  executionId: 'exec_seeded_degraded',
  workflowId: 'wf-degraded-demo',
  status: 'completed',
  startTime: '2026-07-10T09:14:02.000Z',
  endTime: '2026-07-10T09:14:04.000Z',
  degraded: true,
  definitionVersion: 1,
  definitionChangeset: 0,
});
await store.appendExecutionLog({
  tenantId: 't1',
  executionId: 'exec_seeded_degraded',
  sequence: 1,
  event: 'workflow.cloud.routing',
  decision: 'allowed',
  consentAt: '2026-07-14T09:00:00.000Z',
  scope: 'workflow',
  requestedBy: 'jeremy',
  at: '2026-07-10T09:14:02.000Z',
});
await store.appendExecutionLog({
  tenantId: 't1',
  executionId: 'exec_seeded_degraded',
  sequence: 11,
  nodeId: 'node-deg-start',
  nodeType: 'webhookconfig',
  event: 'workflow.node.completed',
  outcome: 'completed',
  binding: 'local',
  at: '2026-07-10T09:14:02.400Z',
});
await store.appendExecutionLog({
  tenantId: 't1',
  executionId: 'exec_seeded_degraded',
  sequence: 21,
  nodeId: 'node-deg-data',
  nodeType: 'data',
  event: 'workflow.node.completed',
  outcome: 'completed',
  binding: 'local-degraded',
  at: '2026-07-10T09:14:03.200Z',
});

// A run whose consent receipt reads "kept local" (the mirror line).
await store.writeExecutionMeta({
  tenantId: 't1',
  executionId: 'exec_seeded_keptlocal',
  workflowId: 'wf-degraded-demo',
  status: 'completed',
  startTime: '2026-07-10T09:11:47.000Z',
  endTime: '2026-07-10T09:11:48.000Z',
  definitionVersion: 1,
  definitionChangeset: 0,
});
await store.appendExecutionLog({
  tenantId: 't1',
  executionId: 'exec_seeded_keptlocal',
  sequence: 1,
  event: 'workflow.cloud.routing',
  decision: 'kept-local',
  requestedBy: 'jeremy',
  at: '2026-07-10T09:11:47.000Z',
});
await store.appendExecutionLog({
  tenantId: 't1',
  executionId: 'exec_seeded_keptlocal',
  sequence: 11,
  nodeId: 'node-deg-data',
  nodeType: 'data',
  event: 'workflow.node.completed',
  outcome: 'completed',
  binding: 'local',
  at: '2026-07-10T09:11:47.500Z',
});

const bus = new LocalEventBus();

// Test-harness-only surface: stop/restart the Helix stub, so the suite can
// prove the offline degrade (static offers, entitlements fail closed).
app.post('/e2e/helix-stub', async (request, reply) => {
  const { up } = request.body as { up: boolean };
  if (!up && helixStub) {
    await helixStub.close();
    helixStub = undefined;
  } else if (up && !helixStub) {
    helixStub = await startHelixStub({}, HELIX_STUB_PORT);
  }
  return reply.send({ up: Boolean(helixStub) });
});

// Test-harness-only surface: simulate a short live run over the bus.
app.post('/e2e/simulate-run', async (request, reply) => {
  const { executionId } = request.body as { executionId: string };
  const emit = (name: WorkflowEventName, nodeId?: string) =>
    bus.emit({
      name,
      tenantId: 't1',
      workflowId: 'wf-runs-demo',
      executionId,
      nodeId,
      timestamp: new Date().toISOString(),
    });
  await store.writeExecutionMeta({
    tenantId: 't1',
    executionId,
    workflowId: 'wf-runs-demo',
    status: 'running',
    startTime: new Date().toISOString(),
  });
  emit('workflow.execution.started');
  setTimeout(() => {
    emit('workflow.node.started', 'node-live-a');
  }, 150);
  setTimeout(() => {
    emit('workflow.node.completed', 'node-live-a');
  }, 400);
  setTimeout(() => {
    store
      .updateExecutionMeta('t1', executionId, { status: 'completed' })
      .then(() => emit('workflow.execution.completed'))
      .catch(() => undefined);
  }, 700);
  return reply.code(202).send({ ok: true });
});

await app.listen({ port: 4181, host: '127.0.0.1' });
attachSocketHub(app.server, { identity, bus });
process.stdout.write('metis-core e2e control plane ready on 4181\n');
