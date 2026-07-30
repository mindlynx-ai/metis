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
 * The data-resource route: the visual table builder's live catalogue. It lists
 * a connection's tables by dispatching listTables through the DataSourcePort,
 * so the inspector can offer real tables instead of a typed name. An engine
 * with no open adapter (athena/snowflake) returns locked, not an error.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  SingleTenantIdentity,
  FakeCredentialPort,
  DataSourceRegistry,
  type DataSource,
} from '@mindlynx/metis-ports';
import { buildCoreServer } from '../server.js';

const postgres: DataSource = {
  engine: 'postgres',
  runQuery: async () => ({ rows: [], rowCount: 0, truncated: false }),
  listTables: async () => [
    { name: 'orders', schema: 'public' },
    { name: 'customers', schema: 'public' },
  ],
  describeTable: async () => [
    { name: 'id', type: 'integer' },
    { name: 'amount', type: 'numeric' },
  ],
  // A valid query describes its columns; anything with 'boom' throws like a real
  // SQL error would (unknown column / bad join).
  describeQuery: async (_connection, sql) => {
    if (sql.includes('boom')) throw new Error('column "boom" does not exist');
    return [
      { name: 'email', type: 'text' },
      { name: 'amount', type: 'numeric' },
    ];
  },
};

describe('data resource routes (the table catalogue)', () => {
  let app: FastifyInstance;
  const credentials = new FakeCredentialPort();
  let token: string;

  beforeAll(async () => {
    const identity = await SingleTenantIdentity.create('t1', [
      { userId: 'jeremy', secret: 'pw', role: 'admin' },
      { userId: 'watcher', secret: 'pw', role: 'viewer' },
    ]);
    app = buildCoreServer({
      identity,
      credentials,
      dataSources: new DataSourceRegistry().register(postgres),
    });
    await app.ready();
    token = (
      (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: 'jeremy', secret: 'pw' } })).json() as {
        token: string;
      }
    ).token;
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  const post = (url: string, body: unknown) =>
    app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: body as Record<string, unknown> });
  const make = (connectorId: string) =>
    app
      .inject({
        method: 'POST',
        url: '/api/connections',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: connectorId, connectorId, material: { host: 'h' } },
      })
      .then((r) => (r.json() as { connectionId: string }).connectionId);

  it('lists a postgres connection tables through the port', async () => {
    const id = await make('postgres');
    const res = await call(`/api/data/tables?connectionId=${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      engine: 'postgres',
      tables: [{ name: 'orders' }, { name: 'customers' }],
    });
  });

  it('describes a table columns through the port', async () => {
    const id = await make('postgres');
    const res = await call(`/api/data/tables/orders/columns?connectionId=${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ columns: [{ name: 'id' }, { name: 'amount' }] });
  });

  it('returns locked (not an error) for an engine with no open adapter', async () => {
    const id = await make('athena');
    const res = await call(`/api/data/tables?connectionId=${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ engine: 'athena', locked: true, tables: [] });
  });

  it('404s an unknown connection', async () => {
    expect((await call('/api/data/tables?connectionId=nope')).statusCode).toBe(404);
  });

  it('400s without a connectionId', async () => {
    expect((await call('/api/data/tables')).statusCode).toBe(400);
  });

  it('validates a query and returns its columns (the future output variables)', async () => {
    const id = await make('postgres');
    const res = await post('/api/data/validate', { connectionId: id, query: 'select email, amount from orders o join customers c on c.id = o.customer_id' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ valid: true, columns: [{ name: 'email' }, { name: 'amount' }] });
  });

  it('reports an invalid query with the database message, not a 500', async () => {
    const id = await make('postgres');
    const res = await post('/api/data/validate', { connectionId: id, query: 'select boom from orders' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ valid: false });
    expect((res.json() as { error: string }).error).toMatch(/boom/);
  });

  it('validate is locked for an engine with no adapter, and 400 without a query', async () => {
    const athena = await make('athena');
    expect((await post('/api/data/validate', { connectionId: athena, query: 'select 1' })).json()).toMatchObject({
      locked: true,
      valid: false,
    });
    const pg = await make('postgres');
    expect((await post('/api/data/validate', { connectionId: pg })).statusCode).toBe(400);
  });

  describe('a viewer cannot reach the tenant database through these routes', () => {
    // These three carried no guard at all. `/validate` is the sharp one: it does
    // not check a query, it EXECUTES it (describeQuery wraps it in a SELECT that
    // still plans and evaluates), so the lowest-privilege account could run
    // author-supplied SQL through somebody else's stored credentials. The other
    // two hand back a live production schema.
    //
    // requireAction('view') would have been no guard either - can() returns true
    // for `view` for every role, so `view` only means "signed in".
    let viewer: string;
    let connectionId: string;

    beforeAll(async () => {
      viewer = (
        (
          await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { userId: 'watcher', secret: 'pw' },
          })
        ).json() as { token: string }
      ).token;
      connectionId = await make('postgres');
    });

    const asViewer = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
      app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${viewer}` },
        ...(payload ? { payload: payload as Record<string, unknown> } : {}),
      });

    it('refuses all three with 403', async () => {
      for (const [method, url, payload] of [
        ['GET', `/api/data/tables?connectionId=${connectionId}`, undefined],
        ['GET', `/api/data/tables/orders/columns?connectionId=${connectionId}`, undefined],
        ['POST', '/api/data/validate', { connectionId, query: 'select 1' }],
      ] as const) {
        const res = await asViewer(method, url, payload);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
    });

    it('does not run the query it refused', async () => {
      // The proof that matters: a refusal that still executed would be no
      // refusal. `boom` throws inside describeQuery, so if the handler ran we
      // would see the database's message rather than a 403.
      const res = await asViewer('POST', '/api/data/validate', {
        connectionId,
        query: 'select boom from orders',
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toMatch(/boom/);
    });

    it('still lets an editor through, so the guard is not simply off', async () => {
      const res = await post('/api/data/validate', { connectionId, query: 'select 1' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ valid: true });
    });
  });
});
