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
 * The lifecycle routes took the id out of the path and handed it to Temporal.
 * Temporal's namespace is not the product's boundary: any workflow id in it
 * answered, whether or not Metis started it, and whether or not it belonged to
 * the caller. Terminate and signal ACT on such a run; describe and status READ
 * one, which is its own disclosure.
 *
 * The test asserts both halves for each route: the refusal is a 404, and the
 * ExecutionPort was never reached on the way to it - a guard that answers 404
 * after terminating the run would pass the first assertion alone.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { SingleTenantIdentity, FakeExecutionPort, type ExecutionPort } from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { buildCoreServer } from '../server.js';

const MINE = 'exec_mine';
/** A workflow id that exists in the namespace but was never started here. */
const THEIRS = 'exec_someone_elses';

/** The fake, plus the two optional methods the routes 501 without, recording
 *  every id it is asked about so "never reached" is checkable. */
class RecordingExecutions extends FakeExecutionPort implements ExecutionPort {
  readonly touched: string[] = [];

  override signal(id: string, name: string, payload?: Record<string, unknown>): Promise<void> {
    this.touched.push(id);
    return super.signal(id, name, payload);
  }

  override cancel(id: string): Promise<void> {
    this.touched.push(id);
    return super.cancel(id);
  }

  override queryStatus(id: string): ReturnType<FakeExecutionPort['queryStatus']> {
    this.touched.push(id);
    return super.queryStatus(id);
  }

  override describe(id: string): Promise<Record<string, unknown>> {
    this.touched.push(id);
    return super.describe(id);
  }

  terminate(id: string): Promise<void> {
    this.touched.push(id);
    return Promise.resolve();
  }

  reset(id: string): Promise<{ runId: string }> {
    this.touched.push(id);
    return Promise.resolve({ runId: 'run-2' });
  }
}

const login = async (app: FastifyInstance) =>
  (
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { userId: 'ed', secret: 'pw' },
      })
    ).json() as { token: string }
  ).token;

describe('a run the caller does not own is not reachable through the lifecycle routes', () => {
  let app: FastifyInstance;
  let executions: RecordingExecutions;
  let token: string;

  beforeEach(async () => {
    const gateway = new DataGateway(
      new SqliteAdapter(join(mkdtempSync(join(tmpdir(), 'metis-own-')), 'a.db')),
    );
    registerWorkflowTables(gateway);
    const store = new WorkflowStore(gateway);
    // One run this instance started, under this tenant.
    await store.writeExecutionMeta({
      tenantId: 't1',
      executionId: MINE,
      workflowId: 'wf-1',
      status: 'running',
      startTime: new Date().toISOString(),
    } as never);
    executions = new RecordingExecutions();
    await executions.start({
      tenantId: 't1',
      workflowId: 'wf-1',
      executionId: MINE,
      workflowType: 'helixWorkflow',
      definition: { nodes: [], edges: [] },
    } as never);
    // The stranger exists in the namespace but never in our store.
    await executions.start({
      tenantId: 'someone-else',
      workflowId: 'wf-x',
      executionId: THEIRS,
      workflowType: 'helixWorkflow',
      definition: { nodes: [], edges: [] },
    } as never);
    const identity = await SingleTenantIdentity.create('t1', [
      { userId: 'ed', secret: 'pw', role: 'editor' },
    ]);
    app = buildCoreServer({ identity, store, executions });
    await app.ready();
    token = await login(app);
  });

  const call = (method: 'GET' | 'POST', path: string, id: string) =>
    app.inject({
      method,
      url: `/api/executions/${id}${path}`,
      headers: { authorization: `Bearer ${token}` },
      ...(method === 'POST'
        ? { payload: path === '/signal' ? { signalType: 'approval:go' } : {} }
        : {}),
    });

  const routes: [('GET' | 'POST'), string][] = [
    ['POST', '/terminate'],
    ['POST', '/reset'],
    ['POST', '/signal'],
    ['POST', '/cancel'],
    ['GET', '/status'],
    ['GET', '/describe'],
    ['GET', '/insight'],
  ];

  it.each(routes)('%s %s 404s for a run this instance never started', async (method, path) => {
    const response = await call(method, path, THEIRS);
    expect(response.statusCode).toBe(404);
    expect(executions.touched).not.toContain(THEIRS);
  });

  it.each(routes)('%s %s still answers for a run the caller owns', async (method, path) => {
    const response = await call(method, path, MINE);
    expect(response.statusCode).toBeLessThan(400);
  });
});
