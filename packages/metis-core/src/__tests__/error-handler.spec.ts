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
 * What a route throw becomes. There was no error handler at all, so every one
 * of these was a bare 500 with the detail going nowhere.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  ConditionFailedError,
  SingleTenantIdentity,
  UnentitledError,
  type ExecutionPort,
  type ExecutionStatusValue,
} from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { buildCoreServer } from '../server.js';

/** A connection string in a message is exactly what must not reach a browser. */
const SECRET_DETAIL = 'postgres://metis:hunter2@internal-db.seillen/orders timed out';

/** Temporal's shape: the class sets `name` on its prototype, nothing else. */
class WorkflowNotFound extends Error {
  override readonly name = 'WorkflowNotFoundError';
}

class ThrowingExecutions implements ExecutionPort {
  start(): Promise<{ executionId: string }> {
    return Promise.resolve({ executionId: 'exec-1' });
  }
  signal(): Promise<void> {
    return Promise.reject(new WorkflowNotFound('workflow execution not found'));
  }
  cancel(): Promise<void> {
    return Promise.resolve();
  }
  queryStatus(): Promise<ExecutionStatusValue> {
    return Promise.reject(new Error(SECRET_DETAIL));
  }
  describe(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }
}

describe('the one error handler', () => {
  let app: FastifyInstance;
  let token: string;
  const logged: string[] = [];

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-errors-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'errors.db')));
    registerWorkflowTables(gateway);
    const identity = await SingleTenantIdentity.create('t1', [
      { userId: 'jeremy', secret: 'pw', role: 'admin' },
    ]);
    const session = await identity.authenticate('jeremy', 'pw');
    token = identity.issueToken(session!);
    const store = new WorkflowStore(gateway);
    // The run is one WE started; Temporal is the side that has forgotten it.
    // Without the row the lifecycle route's ownership check answers first and
    // the Temporal-not-found mapping this test exists for never runs.
    await store.writeExecutionMeta({
      tenantId: 't1',
      executionId: 'exec-gone',
      workflowId: 'wf-1',
      status: 'running',
      startTime: new Date().toISOString(),
    } as never);
    app = buildCoreServer({
      identity,
      store,
      executions: new ThrowingExecutions(),
      // Where an operator would look, captured so this suite can read it.
      logger: {
        level: 'info',
        stream: {
          write: (line: string) => {
            logged.push(line);
          },
        },
      },
    });
    // Registered after the handler, on the same instance, exactly as a route
    // added by an embedding host would be.
    app.get('/spec/conflict', () => {
      throw new ConditionFailedError('"status" is "failed", not "running"');
    });
    app.get('/spec/unentitled', () => {
      throw new UnentitledError();
    });
    app.get('/spec/boom', () => {
      throw new Error(SECRET_DETAIL);
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('gives a mapped error its own status, not 500', async () => {
    const conflict = await get('/spec/conflict');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: 'the resource changed since it was read; reload and retry',
    });

    const unentitled = await get('/spec/unentitled');
    expect(unentitled.statusCode).toBe(402);
    // The uplift errors write their own sentence for the person reading it.
    expect((unentitled.json() as { error: string }).error).toMatch(/Helix plan/);
  });

  it('answers 404 for a signal to a run Temporal no longer has', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/executions/exec-gone/signal',
      payload: { signalType: 'manual' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: string }).error).toMatch(/no such run/);
  });

  it('gives an unmapped throw a 500 that says nothing, and logs what it hid', async () => {
    const response = await get('/spec/boom');
    expect(response.statusCode).toBe(500);
    const body = response.body;
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('internal-db');
    expect(body).not.toContain('at Object');
    const parsed = response.json() as { error: string; requestId: string };
    expect(parsed.error).toBe('internal error');
    expect(parsed.requestId).toBeTruthy();

    // The detail is where an operator would find it, under the id the caller
    // was given to quote.
    const line = logged.find((entry) => entry.includes('unhandled route error'));
    expect(line).toBeDefined();
    expect(line).toContain('hunter2');
    expect(line).toContain(parsed.requestId);
    expect(line).toContain('/spec/boom');
  });

  it('leaves a route that answered for itself alone', async () => {
    // A store read that throws inside a route with its own reply is untouched;
    // and Fastify's own 4xx keeps its status rather than being flattened to 500.
    const unknown = await get('/api/workflows/wf_nope');
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { error: string }).error).toBe('workflow not found');

    const unauthorised = await app.inject({ method: 'GET', url: '/api/workflows' });
    expect(unauthorised.statusCode).toBe(401);
  });
});
