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
 * The action gate, swept rather than spot-checked.
 *
 * A route that changes something or causes one is meant to carry
 * requireAction('edit'); a signed-in session alone is not enough, because
 * `can()` answers 'view' true for every role, so "authenticated" and "may act"
 * are not the same sentence. This has now been the missing half of three
 * separate findings, so the test enumerates every route the server registers
 * and holds the ungated ones against a named list, instead of testing the one
 * route that was reported. A new ungated route fails here on the day it lands.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { SingleTenantIdentity, FakeExecutionPort, FakeCredentialPort } from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { buildCoreServer } from '../server.js';

const USERS = [
  { userId: 'ed', secret: 'pw', role: 'editor' as const },
  { userId: 'watcher', secret: 'pw', role: 'viewer' as const },
];

const login = async (app: FastifyInstance, userId: string) =>
  (
    (
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId, secret: 'pw' } })
    ).json() as { token: string }
  ).token;

/**
 * Routes that answer without an action gate ON PURPOSE. Reads a viewer is
 * meant to have, plus the three that are reached before a session exists at
 * all (sign-in and the two state-authed provider callbacks). Anything not on
 * this list must carry a gate.
 */
const UNGATED_BY_DESIGN = new Set([
  'POST /api/auth/login', //                     the sign-in itself
  'GET /api/oauth/callback', //                  state-authed provider redirect
  'GET /api/account/callback', //                state-authed provider redirect, PKCE
  'GET /api/auth/me', //                         the caller's own session
  'POST /api/auth/logout', //                    ends the caller's own session; every role may
  'GET /api/entitlements',
  'GET /api/offers',
  'GET /api/node-catalogue',
  'GET /api/connectors',
  'GET /api/connectors/oauth-capable',
  'POST /api/workflows/validate', //             pure: validates a graph, stores nothing
  'GET /api/workflows',
  'GET /api/workflows/:workflowId',
  'GET /api/workflows/:workflowId/versions',
  'GET /api/executions',
  'GET /api/executions/:id',
  'GET /api/executions/archive',
  'GET /api/executions/temporal',
  'GET /api/executions/:id/insight',
  'GET /api/executions/:id/status',
  'GET /api/executions/:id/describe',
  'GET /api/connections', //                     list; the single read is gated (it holds material)
  'GET /api/operate/summary',
  'GET /api/operate/schedules',
  'GET /api/audit/:entityType/:entityId',
]);

function freshStore(): WorkflowStore {
  const gateway = new DataGateway(
    new SqliteAdapter(join(mkdtempSync(join(tmpdir(), 'metis-guards-')), 'a.db')),
  );
  registerWorkflowTables(gateway);
  return new WorkflowStore(gateway);
}

const apiDefinition = {
  nodes: [
    { id: 'start', type: 'apiconfig', data: { config: { path: 'orders', method: 'POST' } } },
    { id: 'end', type: 'apiend', data: { config: { responseType: 'sourcedata' } } },
  ],
  edges: [{ source: 'start', target: 'end' }],
};

describe('every route carries an action gate unless it is named as ungated', () => {
  let app: FastifyInstance;
  const seen: { method: string; url: string; gated: boolean }[] = [];

  beforeAll(async () => {
    const store = freshStore();
    await store.putWorkflowVersion({
      tenantId: 't1',
      workflowId: 'wf-orders',
      version: 1,
      changeset: 0,
      status: 'published',
      name: 'api orders',
      type: 'api',
      definition: apiDefinition,
    } as never);
    const identity = await SingleTenantIdentity.create('t1', USERS);
    // Every optional surface wired on, so the sweep sees every route the
    // product can register rather than the subset a minimal build mounts.
    app = buildCoreServer({
      identity,
      store,
      executions: new FakeExecutionPort(),
      credentials: new FakeCredentialPort(),
    });
    // Routes inside the authed scope register during ready(), so a hook added
    // here still sees them; the three registered eagerly are the public ones.
    app.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) {
        seen.push({
          method: String(method),
          url: route.url,
          gated: Boolean(route.preHandler),
        });
      }
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registered enough routes for the sweep to mean anything', () => {
    expect(seen.length).toBeGreaterThan(20);
  });

  it('has no ungated route that is not on the named list', () => {
    const ungated = seen
      .filter((route) => !route.gated && route.method !== 'HEAD' && route.method !== 'OPTIONS')
      .map((route) => `${route.method} ${route.url}`)
      .filter((name) => !UNGATED_BY_DESIGN.has(name))
      .sort();
    expect(ungated).toEqual([]);
  });
});

describe('POST /api/apiworkflow/* runs a published workflow', () => {
  let app: FastifyInstance;
  let executions: FakeExecutionPort;
  let ran: number;
  let editor: string;
  let viewer: string;

  beforeAll(async () => {
    const store = freshStore();
    await store.putWorkflowVersion({
      tenantId: 't1',
      workflowId: 'wf-orders',
      version: 1,
      changeset: 0,
      status: 'published',
      name: 'api orders',
      type: 'api',
      definition: apiDefinition,
    } as never);
    executions = new FakeExecutionPort();
    ran = 0;
    executions.apiRunner = () => {
      ran += 1;
      return Promise.resolve({ executionId: 'e', status: 'completed', response: { ok: 1 }, statusCode: 200 });
    };
    const identity = await SingleTenantIdentity.create('t1', USERS);
    app = buildCoreServer({ identity, store, executions });
    await app.ready();
    editor = await login(app, 'ed');
    viewer = await login(app, 'watcher');
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = (token?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/apiworkflow/orders',
      payload: { a: 1 },
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });

  it('refuses a viewer, and does not run the graph on the way to saying so', async () => {
    const before = ran;
    const response = await call(viewer);
    expect(response.statusCode).toBe(403);
    expect(ran).toBe(before);
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await call()).statusCode).toBe(401);
  });

  it('still runs for an editor', async () => {
    const response = await call(editor);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: 1 });
  });
});
