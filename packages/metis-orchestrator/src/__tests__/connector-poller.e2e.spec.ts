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
 * The poll bridge against a real Temporal: a poll tick starts a
 * durable run per new item on the time-skipping test environment. The
 * unit spec covers the cursor logic with a fake ExecutionPort; this
 * proves the started runs actually execute end to end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import {
  CompositeEventSink,
  FakeCredentialPort,
  LocalEventBus,
  NodeHandlerRegistry,
  StdoutEventSink,
} from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { createActivities } from '@mindlynx/metis-engine';
import { TemporalExecutionAdapter } from '../temporal-execution-adapter.js';
import { ConnectorPoller } from '../connector-poller.js';
import { TriggerService, registerTriggerTable, type TriggerRecord } from '../triggers.js';

const TASK_QUEUE = 'metis-poll-e2e';
const REC = 'node-c1cccccc-1111-4222-8333-444444444444';

describe('poll bridge starts real runs', () => {
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;
  let store: WorkflowStore;
  let triggers: TriggerService;
  let poller: ConnectorPoller;
  let seq = 0;
  const recorded: Record<string, unknown>[] = [];

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const dir = mkdtempSync(join(tmpdir(), 'metis-poll-e2e-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'poll.db')));
    registerWorkflowTables(gateway);
    registerTriggerTable(gateway);
    store = new WorkflowStore(gateway);
    triggers = new TriggerService(gateway, 't1');
    const bus = new LocalEventBus();
    const nodes = new NodeHandlerRegistry();
    nodes.registerNodeHandler('record', (ctx) => {
      recorded.push(ctx.nodeRef.config);
      return Promise.resolve({ status: 200, message: 'ok', nodeData: { data: ctx.nodeRef.config } });
    });
    const events = new CompositeEventSink(new StdoutEventSink(() => undefined), bus);
    worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'metis-engine', 'src', 'workflows', 'index.ts'),
      activities: createActivities({
        store,
        events,
        nodes,
        credentials: new FakeCredentialPort(),
      }),
    });
    workerRun = worker.run();

    const executions = new TemporalExecutionAdapter({ client: env.client, taskQueue: TASK_QUEUE });
    poller = new ConnectorPoller({
      triggers,
      store,
      executions,
      tenantId: 't1',
      fetchItems: async () => fetchQueue,
      newExecutionId: () => `exec_poll_${seq++}`,
    });

    await store.putWorkflowVersion({
      tenantId: 't1',
      workflowId: 'wf-poll',
      version: 1,
      changeset: 0,
      status: 'published',
      name: 'poll target',
      type: 'workflow',
      definition: { nodes: [{ id: REC, type: 'record', config: { tag: 'poll' } }], edges: [] },
    });
  }, 180_000);

  afterAll(async () => {
    poller?.stop();
    worker?.shutdown();
    await workerRun;
    await env?.teardown();
  });

  let fetchQueue: unknown[] = [];

  it('seeds the cursor on the first tick without starting a run', async () => {
    const trg = await triggers.create({ kind: 'poll', workflowId: 'wf-poll', connectorId: 'hubspot', cursorField: 'createdAt' });
    fetchQueue = [{ id: 1, createdAt: '2026-01-01' }];
    const before = recorded.length;
    const outcome = await poller.pollOnce((await triggers.get(trg.triggerId)) as TriggerRecord);
    expect(outcome.seeded).toBe(true);
    expect(recorded).toHaveLength(before);
    expect((await triggers.get(trg.triggerId))?.cursor).toBe('2026-01-01');
  }, 60_000);

  it('starts a durable run for each new item past the cursor', async () => {
    const [trg] = await triggers.listByKind('poll');
    fetchQueue = [
      { id: 2, createdAt: '2026-02-01' },
      { id: 3, createdAt: '2026-03-01' },
    ];
    const before = recorded.filter((c) => c.tag === 'poll').length;
    const outcome = await poller.pollOnce((await triggers.get(trg!.triggerId)) as TriggerRecord);
    expect(outcome.started).toBe(2);

    let ran = 0;
    for (let attempt = 0; attempt < 100 && ran < before + 2; attempt += 1) {
      ran = recorded.filter((c) => c.tag === 'poll').length;
      if (ran < before + 2) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(ran).toBe(before + 2);
    expect((await triggers.get(trg!.triggerId))?.cursor).toBe('2026-03-01');
  }, 60_000);
});
