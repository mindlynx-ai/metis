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

const TASK_QUEUE = 'metis-api-spec';
const CFG = 'node-71aaaaaa-1111-4222-8333-444444444444';
const WORK = 'node-72bbbbbb-1111-4222-8333-444444444444';
const END = 'node-73cccccc-1111-4222-8333-444444444444';
const SLOW = 'node-74dddddd-1111-4222-8333-444444444444';

describe('helixApiWorkflow and start-time validation', () => {
  let env: TestWorkflowEnvironment;
  let store: WorkflowStore;
  let worker: Worker;
  let workerRun: Promise<void>;
  let executionCounter = 0;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const dir = mkdtempSync(join(tmpdir(), 'metis-api-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'api.db')));
    registerWorkflowTables(gateway);
    store = new WorkflowStore(gateway);
    const nodes = new NodeHandlerRegistry();
    nodes.registerNodeHandler('echo', (ctx) =>
      Promise.resolve({ status: 200, message: 'ok', nodeData: { data: { echoed: ctx.nodeRef.config } } }),
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

  const execute = async (
    workflowType: string,
    definition: HelixWorkflowInput['definition'],
    extra: Partial<HelixWorkflowInput> = {},
  ) => {
    executionCounter += 1;
    const executionId = `exec-api-${executionCounter}`;
    const input: HelixWorkflowInput = {
      tenantId: 't1',
      workflowId: 'wf-api',
      executionId,
      definition,
      ...extra,
    };
    const result = await env.client.workflow.execute(workflowType, {
      args: [input],
      workflowId: executionId,
      taskQueue: TASK_QUEUE,
    });
    return { executionId, result: result as Record<string, unknown> };
  };

  it('runs apiconfig to apiend and returns the source node output as the response', async () => {
    const { executionId, result } = await execute('helixApiWorkflow', {
      nodes: [
        { id: CFG, type: 'apiconfig', config: {} },
        { id: WORK, type: 'echo', config: { answer: 42 } },
        { id: END, type: 'apiend', config: { responseType: 'sourcedata' } },
      ],
      edges: [
        { source: CFG, target: WORK },
        { source: WORK, target: END },
      ],
    });
    expect(result.status).toBe('completed');
    expect(result.response).toEqual({ echoed: { answer: 42 } });
    // No apiend statusCode configured -> the response defaults to 200.
    expect(result.statusCode).toBe(200);
    const execution = await store.getExecution('t1', executionId);
    expect(execution?.meta.status).toBe('completed');
  }, 60_000);

  it('seeds the request body onto apiconfig so downstream references resolve', async () => {
    const { result } = await execute(
      'helixApiWorkflow',
      {
        nodes: [
          { id: CFG, type: 'apiconfig', config: {} },
          { id: WORK, type: 'echo', config: { greeting: `Hi ${'{{'}${CFG}.data.name${'}}'}` } },
          { id: END, type: 'apiend', config: { responseType: 'sourcedata' } },
        ],
        edges: [
          { source: CFG, target: WORK },
          { source: WORK, target: END },
        ],
      },
      { input: { name: 'Ada' } },
    );
    expect(result.status).toBe('completed');
    // {{apiconfig.data.name}} resolved from the request body seeded onto API Start.
    expect(result.response).toEqual({ echoed: { greeting: 'Hi Ada' } });
  }, 60_000);

  it('reads apiend config from the Helix data.config shape (status + mapping)', async () => {
    const { result } = await execute('helixApiWorkflow', {
      nodes: [
        { id: CFG, type: 'apiconfig', data: { config: {} } },
        { id: WORK, type: 'echo', data: { config: { answer: 'seven' } } },
        {
          id: END,
          type: 'apiend',
          data: {
            config: {
              responseType: 'mappeddata',
              responseMapping: { picked: `{{${WORK}.data.echoed.answer}}` },
              statusCode: 201,
            },
          },
        },
      ] as never,
      edges: [
        { source: CFG, target: WORK },
        { source: WORK, target: END },
      ],
    });
    expect(result.status).toBe('completed');
    // The config lives under data.config (how the editor saves it); both the
    // status and the mapped body must still be read.
    expect(result.statusCode).toBe(201);
    expect(result.response).toEqual({ picked: 'seven' });
  }, 60_000);

  it('carries a custom statusCode from apiend', async () => {
    const { result } = await execute('helixApiWorkflow', {
      nodes: [
        { id: CFG, type: 'apiconfig', config: {} },
        { id: WORK, type: 'echo', config: { ok: true } },
        { id: END, type: 'apiend', config: { responseType: 'sourcedata', statusCode: 201 } },
      ],
      edges: [
        { source: CFG, target: WORK },
        { source: WORK, target: END },
      ],
    });
    expect(result.status).toBe('completed');
    expect(result.statusCode).toBe(201);
  }, 60_000);

  it('maps the response when apiend uses mappeddata', async () => {
    const { result } = await execute('helixApiWorkflow', {
      nodes: [
        { id: CFG, type: 'apiconfig', config: {} },
        { id: WORK, type: 'echo', config: { answer: 'mapped-me' } },
        {
          id: END,
          type: 'apiend',
          config: {
            responseType: 'mappeddata',
            responseMapping: { picked: `{{${WORK}.data.echoed.answer}}` },
          },
        },
      ],
      edges: [
        { source: CFG, target: WORK },
        { source: WORK, target: END },
      ],
    });
    expect(result.status).toBe('completed');
    expect(result.response).toEqual({ picked: 'mapped-me' });
  }, 60_000);

  it('fails cleanly when the bounded deadline is exceeded', async () => {
    const { executionId, result } = await execute(
      'helixApiWorkflow',
      {
        nodes: [
          { id: CFG, type: 'apiconfig', config: {} },
          { id: SLOW, type: 'waituntil', config: { waitHours: 5 } },
          { id: END, type: 'apiend', config: { responseType: 'sourcedata' } },
        ],
        edges: [
          { source: CFG, target: SLOW },
          { source: SLOW, target: END },
        ],
      },
      { deadlineMs: 60_000 },
    );
    expect(result.status).toBe('failed');
    const execution = await store.getExecution('t1', executionId);
    expect(execution?.meta.status).toBe('failed');
    expect(String(execution?.meta.failureReason ?? '')).toMatch(/deadline/i);
  }, 60_000);

  it('rejects an invalid definition at start (two start nodes)', async () => {
    let failure: unknown;
    try {
      await execute('helixWorkflow', {
        nodes: [
          { id: WORK, type: 'echo', config: {} },
          { id: SLOW, type: 'echo', config: {} },
        ],
        edges: [],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    const chain: string[] = [];
    let cursor = failure as { message?: string; cause?: unknown } | undefined;
    while (cursor) {
      if (cursor.message) chain.push(cursor.message);
      cursor = cursor.cause as { message?: string; cause?: unknown } | undefined;
    }
    expect(chain.join(' | ')).toMatch(/exactly one start node/i);
  }, 60_000);
});
