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
 * Webhook delivery idempotency against a real Temporal.
 *
 * A fake ExecutionPort could not prove this. The claim is that Temporal refuses
 * a second start under a delivery's id, and Temporal's DEFAULT is to allow one
 * once the first run has closed - which is precisely the retry a sender makes
 * when its first attempt timed out. So each case here waits for the first run to
 * FINISH before replaying the delivery, which is the only ordering that tells
 * the reuse policy apart from doing nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { FakeCredentialPort, LocalEventBus, NodeHandlerRegistry } from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { createActivities } from '@mindlynx/metis-engine';
import { TemporalExecutionAdapter } from '../temporal-execution-adapter.js';
import { handleWebhook, type WebhookDeps } from '../webhook-ingress.js';
import { TriggerService, registerTriggerTable } from '../triggers.js';

const TASK_QUEUE = 'metis-webhook-idempotency';
const SHIP = 'node-c1dddddd-1111-4222-8333-444444444444';

describe('a retried webhook delivery does not ship the order twice', () => {
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;
  let triggers: TriggerService;
  let deps: WebhookDeps;
  let triggerId: string;
  let minted = 0;
  const shipped: unknown[] = [];

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const dir = mkdtempSync(join(tmpdir(), 'metis-webhook-idem-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'hooks.db')));
    registerWorkflowTables(gateway);
    registerTriggerTable(gateway);
    const store = new WorkflowStore(gateway);
    triggers = new TriggerService(gateway, 't1');
    const nodes = new NodeHandlerRegistry();
    nodes.registerNodeHandler('ship', (ctx) => {
      shipped.push(ctx.nodeRef.config);
      return Promise.resolve({ status: 200, message: 'ok', nodeData: { data: {} } });
    });
    worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'metis-engine',
        'src',
        'workflows',
        'index.ts',
      ),
      activities: createActivities({
        store,
        events: new LocalEventBus(),
        nodes,
        credentials: new FakeCredentialPort(),
      }),
    });
    workerRun = worker.run();

    await store.putWorkflowVersion({
      tenantId: 't1',
      workflowId: 'wf-orders',
      version: 1,
      changeset: 0,
      status: 'published',
      name: 'ship the order',
      type: 'workflow',
      definition: { nodes: [{ id: SHIP, type: 'ship', config: { tag: 'order' } }], edges: [] },
    });
    triggerId = (
      await triggers.create({ kind: 'webhook', workflowId: 'wf-orders', verification: 'none' })
    ).triggerId;

    deps = {
      triggers,
      store,
      executions: new TemporalExecutionAdapter({ client: env.client, taskQueue: TASK_QUEUE }),
      tenantId: 't1',
      newExecutionId: () => {
        minted += 1;
        return `exec_minted_${minted}`;
      },
      now: () => '2026-07-30T00:00:00Z',
    };
  }, 180_000);

  afterAll(async () => {
    worker?.shutdown();
    await workerRun;
    await env?.teardown();
  });

  const deliver = (headers: Record<string, string>) =>
    handleWebhook(deps, { triggerId, rawBody: '{"order":1}', headers });

  /** Wait for the graph to have run `count` times in total. */
  const settled = async (count: number) => {
    for (let attempt = 0; attempt < 100 && shipped.length < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // A little longer, so an unwanted SECOND run has time to appear and fail
    // the count rather than being missed by an early assertion.
    await new Promise((resolve) => setTimeout(resolve, 300));
    return shipped.length;
  };

  it('runs the graph once for a delivery id replayed after the first run closed', async () => {
    const first = await deliver({ 'x-github-delivery': 'delivery-a' });
    expect(first.status).toBe(202);
    expect(await settled(1)).toBe(1);

    const retry = await deliver({ 'x-github-delivery': 'delivery-a' });
    expect(retry.status).toBe(202);
    expect(retry.executionId).toBe(first.executionId);
    expect(retry.duplicate).toBe(true);
    expect(await settled(2)).toBe(1);
  }, 120_000);

  it('runs a genuinely new delivery', async () => {
    const other = await deliver({ 'x-github-delivery': 'delivery-b' });
    expect(other.status).toBe(202);
    expect(other.duplicate).toBeUndefined();
    expect(other.executionId).not.toBe(`hook_${triggerId}_delivery-a`);
    expect(await settled(2)).toBe(2);
  }, 120_000);

  it('keeps the minted id when the sender identifies nothing', async () => {
    const before = minted;
    const one = await deliver({});
    const two = await deliver({});
    expect(minted).toBe(before + 2);
    expect(one.executionId).not.toBe(two.executionId);
    expect(one.duplicate).toBeUndefined();
    expect(two.duplicate).toBeUndefined();
    expect(await settled(4)).toBe(4);
  }, 120_000);
});
