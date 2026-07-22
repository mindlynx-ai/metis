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
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import {
  CapturingEventSink,
  FakeCredentialPort,
  NodeHandlerRegistry,
  WORKFLOW_EVENT_NAMES,
} from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { createActivities } from '../activities/create-activities.js';
import type { HelixWorkflowInput } from '../types.js';

const TASK_QUEUE = 'metis-audit-spec';
const N1 = 'node-d1aaaaaa-1111-4222-8333-444444444444';
const N2 = 'node-d2bbbbbb-1111-4222-8333-444444444444';
const N3 = 'node-d3cccccc-1111-4222-8333-444444444444';
const N4 = 'node-d4dddddd-1111-4222-8333-444444444444';

describe('the full lifecycle event surface and adapter swap', () => {
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;
  let store: WorkflowStore;
  let events: CapturingEventSink;
  const fetchCalls: string[] = [];

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const dir = mkdtempSync(join(tmpdir(), 'metis-audit-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'audit.db')));
    registerWorkflowTables(gateway);
    store = new WorkflowStore(gateway);
    events = new CapturingEventSink();
    const nodes = new NodeHandlerRegistry();
    nodes.registerNodeHandler('echo', (ctx) =>
      Promise.resolve({ status: 200, message: 'ok', nodeData: { data: { echoed: ctx.nodeRef.config } } }),
    );
    nodes.registerNodeHandler('boom', () => Promise.reject(new Error('deliberate failure')));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      fetchCalls.push(String(args[0]));
      return originalFetch(...args);
    }) as typeof fetch;

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

  const run = async (
    executionId: string,
    definition: HelixWorkflowInput['definition'],
    input?: Record<string, unknown>,
  ) => {
    const handle = await env.client.workflow.start('helixWorkflow', {
      args: [{ tenantId: 't1', workflowId: 'wf-audit', executionId, definition, input }],
      workflowId: executionId,
      taskQueue: TASK_QUEUE,
    });
    return handle;
  };

  it('emits every lifecycle event across the run matrix, with no external calls', async () => {
    // Success run with a switch orphan, a signal wait and a resume, and
    // an unimplemented paid node.
    const handle = await run(
      'exec-audit-1',
      {
        nodes: [
          {
            id: N1,
            type: 'switch',
            config: {
              switchOptions: [
                { id: 'left', conditions: [{ property: 'input.kind', checkValue: 'left', checkOperator: '===' }] },
              ],
            },
          },
          { id: N2, type: 'signal', config: { signalType: 'go' } },
          { id: N3, type: 'echo', config: {} },
          { id: N4, type: 'cortex.memory.read', config: {} },
        ],
        edges: [
          { source: N1, target: N2, sourceHandle: 'source-left' },
          { source: N1, target: N3, sourceHandle: 'source-default' },
          { source: N2, target: N4 },
        ],
      },
      { kind: 'left' },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await handle.signal('helixSignal', { signalType: 'go', signalParams: { ok: true } });
    await handle.result();

    // Failure run.
    const failing = await run('exec-audit-2', {
      nodes: [{ id: N3, type: 'boom', config: {} }],
      edges: [],
    });
    await failing.result();

    // Cancelled run.
    const cancelled = await run('exec-audit-3', {
      nodes: [
        { id: N2, type: 'signal', config: { signalType: 'never' } },
        { id: N3, type: 'echo', config: {} },
      ],
      edges: [{ source: N2, target: N3 }],
    });
    await cancelled.signal('helixCancelSignal', { cancelledBy: 'audit' });
    await cancelled.result();

    const seen = new Set(events.events.map((event) => event.name));
    for (const name of WORKFLOW_EVENT_NAMES) {
      expect(seen.has(name), `expected ${name} to be emitted`).toBe(true);
    }

    // Run history is fully readable from SQLite.
    const execution = await store.getExecution('t1', 'exec-audit-1');
    expect(execution?.meta.status).toBe('completed');
    expect(execution?.logs.length).toBeGreaterThan(3);

    // No external network call was made by any engine or node code.
    expect(fetchCalls).toEqual([]);
  }, 120_000);

  it('the engine never imports a concrete adapter (swap is configuration only)', () => {
    const engineSrc = join(dirname(fileURLToPath(import.meta.url)), '..');
    const forbidden = [
      'StdoutEventSink',
      'LocalEventBus',
      'SqliteAdapter',
      'PostgresAdapter',
      'LocalFileCredentialStore',
      'SingleTenantIdentity',
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const text = readFileSync(full, 'utf8');
          for (const name of forbidden) {
            if (text.includes(name)) offenders.push(`${entry.name}: ${name}`);
          }
        }
      }
    };
    walk(engineSrc);
    expect(offenders).toEqual([]);
  });
});
