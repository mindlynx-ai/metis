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

describe('filtering a dataset handle pushes down instead of pulling back', () => {
  const REF = { kind: 'dataset', connectionId: 'conn1', engine: 'postgres', query: 'select * from orders' };
  const run = async (config: Record<string, unknown>) => {
    const { handler, seen } = build();
    const result = await handler(nodeCtx('data', { connectorId: 'conn1', sourceRef: REF, ...config }));
    return { result, seen };
  };

  it('opens the handle unchanged when the step narrows nothing', async () => {
    const { result, seen } = await run({});
    expect(result.status).toBe(200);
    expect(seen.sql).toBe('select * from orders');
  });

  it('wraps the handle as a derived table to filter it', async () => {
    const { seen } = await run({ where: [{ column: 'amount', operator: '>', value: 100 }] });
    expect(seen.sql).toBe('SELECT * FROM (select * from orders) AS "source" WHERE "source"."amount" > $1');
    // Bound, never interpolated: pushing a filter down is not worth opening an
    // injection hole on the way.
    expect(seen.params).toEqual([100]);
  });

  it('pushes a cap and an order down too', async () => {
    const { seen } = await run({ limit: 10, orderBy: [{ column: 'created_at', direction: 'descending' }] });
    expect(seen.sql).toBe(
      'SELECT * FROM (select * from orders) AS "source" ORDER BY "source"."created_at" DESC LIMIT 10',
    );
  });

  it('narrows the columns rather than selecting them all', async () => {
    const { seen } = await run({ tables: [{ name: 'ignored', columns: [{ name: 'id' }, { name: 'amount' }] }] });
    expect(seen.sql).toBe('SELECT "source"."id", "source"."amount" FROM (select * from orders) AS "source"');
  });

  it('refuses hand-written SQL alongside a handle instead of dropping it', async () => {
    // The silent case this replaces: the step looked filtered and returned
    // every row the upstream query produced.
    const { result, seen } = await run({ query: 'select * from orders where amount > 100' });
    expect(result.status).toBe(400);
    expect(result.message).toMatch(/cannot also run/i);
    expect(seen.sql).toBeUndefined();
  });

  it('refuses to write through a handle', async () => {
    const { result } = await run({ operation: 'delete', where: [{ column: 'id', operator: '=', value: 1 }] });
    expect(result.status).toBe(400);
  });
});

describe('a builder-authored reference travels as ingredients, not as SQL', () => {
  const BUILT = { connectorId: 'conn1', engine: 'postgres', operation: 'select', output: 'reference' };

  it('emits the spec form (table + narrowing) for a visually built step', async () => {
    const { handler, seen } = build();
    const result = await handler(
      nodeCtx('data', {
        ...BUILT,
        tables: [{ name: 'orders', columns: [{ name: 'id' }] }],
        where: [{ column: 'status', operator: '=', value: 'paid' }],
        limit: 100,
      }),
    );
    expect(result.status).toBe(200);
    expect(nodeOutput(result)).toEqual({
      dataset: {
        kind: 'dataset',
        connectionId: 'conn1',
        engine: 'postgres',
        table: 'orders',
        narrow: {
          columns: [{ name: 'id' }],
          where: [{ column: 'status', operator: '=', value: 'paid' }],
          limit: 100,
        },
      },
    });
    expect(seen.sql).toBeUndefined();
  });

  it('leaves `narrow` off entirely when the step reads the whole table', async () => {
    const { handler } = build();
    const result = await handler(nodeCtx('data', { ...BUILT, tables: [{ name: 'orders' }] }));
    expect(nodeOutput(result)).toEqual({
      dataset: { kind: 'dataset', connectionId: 'conn1', engine: 'postgres', table: 'orders' },
    });
  });

  it('keeps the raw form for hand-written SQL, because the query is all we know', async () => {
    const { handler } = build();
    const result = await handler(
      nodeCtx('data', { connectorId: 'conn1', engine: 'postgres', query: 'select * from orders o join returns r on 1=1', output: 'reference' }),
    );
    expect(nodeOutput(result)).toMatchObject({
      dataset: { query: 'select * from orders o join returns r on 1=1' },
    });
    expect((nodeOutput(result) as { dataset: { table?: string } }).dataset.table).toBeUndefined();
  });

  it('keeps the raw form when the step names a schema, which `table` cannot carry', async () => {
    // A spec handle would resolve to public.orders instead: a different table,
    // and no error to say so.
    const { handler } = build();
    const result = await handler(
      nodeCtx('data', { ...BUILT, schema: 'analytics', tables: [{ name: 'orders' }] }),
    );
    expect(nodeOutput(result)).toMatchObject({
      dataset: { query: 'SELECT * FROM "analytics"."orders"' },
    });
  });
});

describe('opening a spec handle composes ONE flat statement', () => {
  const SPEC = {
    kind: 'dataset',
    connectionId: 'conn1',
    engine: 'postgres',
    table: 'gold_orders',
    narrow: { where: [{ column: 'status', operator: '=', value: 'paid' }], limit: 100 },
  };
  const run = async (config: Record<string, unknown>, ref: unknown = SPEC) => {
    const { handler, seen } = build();
    const result = await handler(nodeCtx('data', { connectorId: 'conn1', sourceRef: ref, ...config }));
    return { result, seen };
  };

  it('opens the handle from its ingredients when the step narrows nothing', async () => {
    const { result, seen } = await run({});
    expect(result.status).toBe(200);
    expect(seen.sql).toBe(
      'SELECT * FROM "public"."gold_orders" WHERE "gold_orders"."status" = $1 LIMIT 100',
    );
    expect(seen.params).toEqual(['paid']);
  });

  it('never wraps: a narrowed spec handle has no subquery in it at all', async () => {
    const { seen } = await run({
      tables: [{ name: 'ignored', columns: [{ name: 'id' }, { name: 'total' }] }],
      where: [{ column: 'total', operator: '>', value: 500 }],
    });
    // The whole point: an engine that must prove a query reads one account only
    // refuses any derived table, so this shape has to stay flat.
    expect(String(seen.sql)).not.toContain('(SELECT');
    expect(String(seen.sql)).not.toContain('(select');
    expect(seen.sql).toBe(
      'SELECT "gold_orders"."id", "gold_orders"."total" FROM "public"."gold_orders" ' +
        'WHERE "gold_orders"."status" = $1 AND "gold_orders"."total" > $2 LIMIT 100',
    );
  });

  it('keeps both sets of predicates with their values still bound in reading order', async () => {
    const { seen } = await run({ where: [{ column: 'region', operator: '=', value: 'eu' }] });
    expect(seen.params).toEqual(['paid', 'eu']);
  });

  it('takes the tighter cap and the step\'s own order', async () => {
    const { seen } = await run({ limit: 10, orderBy: [{ column: 'total', direction: 'descending' }] });
    expect(seen.sql).toBe(
      'SELECT * FROM "public"."gold_orders" WHERE "gold_orders"."status" = $1 ' +
        'ORDER BY "gold_orders"."total" DESC LIMIT 10',
    );
  });

  it('opens a spec handle that narrows nothing of its own', async () => {
    const { seen } = await run({}, { kind: 'dataset', connectionId: 'conn1', engine: 'postgres', table: 'gold_orders' });
    expect(seen.sql).toBe('SELECT * FROM "public"."gold_orders"');
  });

  it('refuses a handle that names no connection rather than borrowing the step\'s own', async () => {
    // A cloud step's handle names no connection (the account supplies the
    // warehouse). Falling back to conn1 would run the warehouse's table name
    // against the user's own database: different rows, status 200.
    const { result, seen } = await run({}, { ...SPEC, connectionId: '' });
    expect(result.status).toBe(400);
    expect(result.message).toMatch(/ran in the cloud/i);
    expect(seen.sql).toBeUndefined();
  });

  it('still refuses to write through a handle', async () => {
    const { result, seen } = await run({ operation: 'delete', where: [{ column: 'id', operator: '=', value: 1 }] });
    expect(result.status).toBe(400);
    expect(result.message).toMatch(/only be read from/i);
    expect(seen.sql).toBeUndefined();
  });

  it('still refuses hand-written SQL alongside a handle', async () => {
    const { result, seen } = await run({ query: 'select * from gold_orders' });
    expect(result.status).toBe(400);
    expect(result.message).toMatch(/cannot also run/i);
    expect(seen.sql).toBeUndefined();
  });
});
