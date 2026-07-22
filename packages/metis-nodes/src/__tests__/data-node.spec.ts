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
import { describe, it, expect } from 'vitest';
import {
  FakeCredentialPort,
  nodeCtx,
  nodeOutput,
  DataSourceRegistry,
  type DataSource,
} from '@mindlynx/metis-ports';
import { createDataNodeHandler } from '../data-node.js';

function build(engine = 'postgres') {
  const seen: { sql?: string; params?: unknown[] } = {};
  const source: DataSource = {
    engine,
    runQuery: async (_connection, sql, options) => {
      seen.sql = sql;
      seen.params = options?.params;
      return { rows: [{ x: 1 }], rowCount: 1, truncated: false };
    },
    listTables: async () => [],
    describeTable: async () => [],
  };
  const sources = new DataSourceRegistry().register(source);
  const credentials = new FakeCredentialPort(
    {},
    { 't1/conn1': { name: 'db', connectorId: 'postgres', material: { host: 'h' } } },
  );
  return { handler: createDataNodeHandler(sources, credentials), seen };
}

describe('the generic data node', () => {
  it('runs a raw SQL query through the connection engine', async () => {
    const { handler, seen } = build();
    const result = await handler(nodeCtx('data', { connectorId: 'conn1', engine: 'postgres', query: 'select 1' }));
    expect(result.status).toBe(200);
    expect(nodeOutput(result)).toMatchObject({ rows: [{ x: 1 }], rowCount: 1 });
    expect(seen.sql).toBe('select 1');
  });

  it('exposes the first record as `row` for a single-record downstream reference', async () => {
    const { handler } = build();
    const result = await handler(nodeCtx('data', { connectorId: 'conn1', engine: 'postgres', query: 'select 1' }));
    expect(nodeOutput(result)).toMatchObject({ row: { x: 1 } });
  });

  it('builds SQL from the visual table operation (no raw SQL)', async () => {
    const { handler, seen } = build();
    const result = await handler(
      nodeCtx('data', { connectorId: 'conn1', engine: 'postgres', operation: 'select', tables: [{ name: 'orders' }] }),
    );
    expect(result.status).toBe(200);
    expect(String(seen.sql)).toMatch(/select .* from .*orders/i);
  });

  it('rejects an engine with no adapter, pointing at Helix', async () => {
    const { handler } = build('postgres'); // registry only holds postgres
    const result = await handler(nodeCtx('data', { connectorId: 'conn1', engine: 'athena', query: 'select 1' }));
    expect(result.status).toBe(400);
    expect(result.message).toMatch(/helix/i);
  });

  it('requires a connection and a query or an operation', async () => {
    const { handler } = build();
    expect((await handler(nodeCtx('data', { engine: 'postgres', query: 'x' }))).status).toBe(400);
    expect((await handler(nodeCtx('data', { connectorId: 'conn1', engine: 'postgres' }))).status).toBe(400);
  });

  it('defaults the engine to postgres for a connection with none set', async () => {
    const { handler, seen } = build();
    const result = await handler(nodeCtx('data', { connectorId: 'conn1', query: 'select 2' }));
    expect(result.status).toBe(200);
    expect(seen.sql).toBe('select 2');
  });

  it('produces a dataset reference instead of rows, without running the query', async () => {
    const { handler, seen } = build();
    const result = await handler(
      nodeCtx('data', { connectorId: 'conn1', engine: 'postgres', query: 'select * from orders', output: 'reference' }),
    );
    expect(result.status).toBe(200);
    expect(nodeOutput(result)).toEqual({
      dataset: { kind: 'dataset', connectionId: 'conn1', engine: 'postgres', query: 'select * from orders' },
    });
    // A reference is a cheap handle: it must NOT run the query.
    expect(seen.sql).toBeUndefined();
  });

  it('materialises a dataset reference handed in as an object', async () => {
    const { handler, seen } = build();
    const ref = { kind: 'dataset', connectionId: 'conn1', engine: 'postgres', query: 'select * from orders' };
    const result = await handler(nodeCtx('data', { sourceRef: ref }));
    expect(result.status).toBe(200);
    expect(nodeOutput(result)).toMatchObject({ rows: [{ x: 1 }], rowCount: 1 });
    expect(seen.sql).toBe('select * from orders');
  });

  it('materialises a dataset reference handed in as its JSON string (templated field)', async () => {
    const { handler, seen } = build();
    const ref = { kind: 'dataset', connectionId: 'conn1', engine: 'postgres', query: 'select 7' };
    const result = await handler(nodeCtx('data', { sourceRef: JSON.stringify(ref) }));
    expect(result.status).toBe(200);
    expect(seen.sql).toBe('select 7');
  });

  it('refuses to make a reference for a write operation', async () => {
    const { handler, seen } = build();
    const result = await handler(
      nodeCtx('data', { connectorId: 'conn1', operation: 'insert', tables: [{ name: 'orders', values: { a: 1 } }], output: 'reference' }),
    );
    expect(result.status).toBe(400);
    expect(seen.sql).toBeUndefined();
  });
});
