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
 * Databases, for real, through a workflow. The e-commerce spec puts database
 * read/write at rank 11 and three use cases depend on it, but until now nothing
 * in the acceptance suite had ever queried one: the adapter had unit tests and
 * the gateway conformance suite exercised Metis's OWN storage, which is a
 * different seam entirely.
 *
 * The cases are written once and run against every configured engine, because
 * "engine-agnostic data node" is a claim that only means something when more
 * than one engine passes the same suite.
 *
 * Postgres defaults to the sample database the repo documents:
 *   docker compose -f compose/docker-compose.yml \
 *                  -f compose/docker-compose.sample-db.yml up -d
 * Any engine that cannot be reached is skipped by name, never silently.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, client, login, node, nodeId, runtimeUp } from '../harness.js';
import { cancelStragglers, edge, outputOf, settled, startRun, until, type Api } from './shop.js';

/** Credentials for a host/port engine, or undefined when it is not configured. */
function material(prefix: string, fallback?: Record<string, string>): Record<string, string> | undefined {
  const host = process.env[`${prefix}_HOST`];
  if (!host) return fallback;
  return {
    host,
    port: process.env[`${prefix}_PORT`] ?? '',
    database: process.env[`${prefix}_DATABASE`] ?? '',
    user: process.env[`${prefix}_USER`] ?? '',
    password: process.env[`${prefix}_PASSWORD`] ?? '',
  };
}

/**
 * SQL Server takes the same host/port credentials as the other two and one
 * more: the container presents a self-signed certificate, as every SQL Server
 * does until somebody installs a real one, so the connection has to say it
 * trusts it. That is a property of the connection, which is why it is material
 * rather than a flag on the adapter.
 */
function sqlServerMaterial(): Record<string, string> | undefined {
  const base = material('METIS_SQLSERVER', {
    host: 'sqlserver',
    port: '1433',
    // The images seed no database, so the fixture lives in master.
    database: 'master',
    user: 'sa',
    // The throwaway password the sample compose file publishes in the open,
    // next to the other two. It only looks like a real one because SQL Server
    // refuses to start on a password as plain as "sample".
    // eslint-disable-next-line sonarjs/no-hardcoded-passwords
    password: 'Metis-Sample-1',
  });
  return base && { ...base, trustServerCertificate: 'true' };
}

/**
 * Snowflake's credentials are a different shape entirely: the SQL API never
 * takes a password. Either a programmatic access token or a key pair will do,
 * so the fixture accepts whichever is configured. The private key may be given
 * inline or as a path, because a PEM in an environment variable is awkward to
 * quote.
 */
function snowflakeMaterial(): Record<string, string> | undefined {
  const account = process.env.METIS_SNOWFLAKE_ACCOUNT;
  const token = process.env.METIS_SNOWFLAKE_TOKEN ?? '';
  const keyPath = process.env.METIS_SNOWFLAKE_PRIVATE_KEY_PATH;
  const privateKey = process.env.METIS_SNOWFLAKE_PRIVATE_KEY ?? (keyPath ? readFileSync(keyPath, 'utf8') : '');
  if (!account || (!privateKey && !token)) return undefined;
  return {
    account,
    token,
    user: process.env.METIS_SNOWFLAKE_USER ?? '',
    privateKey,
    passphrase: process.env.METIS_SNOWFLAKE_PASSPHRASE ?? '',
    warehouse: process.env.METIS_SNOWFLAKE_WAREHOUSE ?? '',
    database: process.env.METIS_SNOWFLAKE_DATABASE ?? '',
    schema: process.env.METIS_SNOWFLAKE_SCHEMA ?? 'PUBLIC',
    role: process.env.METIS_SNOWFLAKE_ROLE ?? '',
  };
}

interface EngineFixture {
  /** The engine the data node dispatches on. */
  engine: string;
  /** The connector record a connection is created against. */
  connectorId: string;
  material?: Record<string, string>;
  /** An EXISTING connection to reuse, instead of creating one from material.
   *  This is the honest way to test a hosted warehouse: it exercises the very
   *  connection an operator made in the UI, and the suite never needs a second
   *  copy of the credentials. */
  connectionId?: string;
  /** How the connection is stored: most engines are host/port, Snowflake is a
   *  key pair, and the adapter reads whichever keys its own material carries. */
  authScheme?: string;
  /** Statements that build the shared fixture where it is not seeded by an
   *  init script (a hosted warehouse has no compose file to seed it). */
  seed?: string[];
  /** A scratch table name this engine's cases create and drop. */
  scratch: string;
  /** Hand-written SQL stays the author's own dialect, so the cases bind the
   *  way the engine does: $1 for Postgres, ? for MySQL, @p1 for SQL Server. */
  placeholder: (index: number) => string;
  /** Whether the visual builder can generate for this engine (reads only). */
  builder: boolean;
}

const ENGINES: EngineFixture[] = [
  {
    engine: 'postgres',
    connectorId: 'postgres',
    // The documented sample database, reachable from the runtime container by
    // its compose service name.
    material: material('METIS_PG', {
      host: 'postgres',
      port: '5432',
      database: 'metis_sample',
      user: 'metis',
      password: 'sample',
    }),
    scratch: 'metis_probe_pg',
    placeholder: (index) => `$${index}`,
    builder: true,
  },
  {
    engine: 'mysql',
    connectorId: 'mysql',
    material: material('METIS_MYSQL', {
      host: 'mysql',
      port: '3306',
      database: 'metis_sample',
      user: 'metis',
      password: 'sample',
    }),
    scratch: 'metis_probe_my',
    placeholder: () => '?',
    builder: true,
  },
  {
    engine: 'sqlserver',
    connectorId: 'sqlserver',
    material: sqlServerMaterial(),
    // Microsoft's images create no database and run no init script, so the
    // container arrives with nothing but master in it: the fixture is built
    // here, exactly as it is for a hosted warehouse.
    seed: [
      "IF OBJECT_ID('orders', 'U') IS NOT NULL DROP TABLE orders",
      'CREATE TABLE orders (id int, customer varchar(128), email varchar(190), amount decimal(10,2), status varchar(32))',
      `INSERT INTO orders (id, customer, email, amount, status) VALUES
         (1, 'Ada Lovelace', 'ada@example.com', 129.00, 'paid'),
         (2, 'Alan Turing', 'alan@example.com', 59.50, 'paid'),
         (3, 'Grace Hopper', 'grace@example.com', 240.00, 'refunded'),
         (4, 'Katherine Johnson', 'kj@example.com', 88.25, 'paid'),
         (5, 'Linus Torvalds', 'linus@example.com', 15.00, 'pending'),
         (6, 'Margaret Hamilton', 'mh@example.com', 512.75, 'paid')`,
    ],
    scratch: 'metis_probe_ms',
    // The driver binds by name, so a positional value is @p1 here.
    placeholder: (index) => `@p${index}`,
    builder: true,
  },
  {
    engine: 'snowflake',
    connectorId: 'snowflake',
    connectionId: process.env.METIS_SNOWFLAKE_CONNECTION,
    material: snowflakeMaterial(),
    authScheme: 'keypair',
    // A hosted warehouse arrives empty, so the shared fixture is built here.
    seed: [
      'CREATE OR REPLACE TABLE orders (id int, customer varchar, email varchar, amount number(10,2), status varchar)',
      `INSERT INTO orders (id, customer, email, amount, status) VALUES
         (1, 'Ada Lovelace', 'ada@example.com', 129.00, 'paid'),
         (2, 'Alan Turing', 'alan@example.com', 59.50, 'paid'),
         (3, 'Grace Hopper', 'grace@example.com', 240.00, 'refunded'),
         (4, 'Katherine Johnson', 'kj@example.com', 88.25, 'paid'),
         (5, 'Linus Torvalds', 'linus@example.com', 15.00, 'pending'),
         (6, 'Margaret Hamilton', 'mh@example.com', 512.75, 'paid')`,
    ],
    scratch: 'metis_probe_sf',
    // The SQL API binds positionally with `?`, whatever the placeholder looks
    // like in the console.
    placeholder: () => '?',
    // The builder quotes identifiers, and a quoted name is case-SENSITIVE in
    // Snowflake while an unquoted one folds to upper case, so generated SQL
    // would miss tables that exist. Raw SQL is unaffected.
    builder: false,
  },
];

/** A column by name, whatever case the engine returns it in: Snowflake folds
 *  unquoted identifiers to upper case, the others keep them as written. */
function pick(row: Record<string, unknown>, column: string): unknown {
  const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === column.toLowerCase());
  return key === undefined ? undefined : row[key];
}

interface DataOutput {
  rows?: Record<string, unknown>[];
  row?: Record<string, unknown>;
  columns?: { name: string }[];
  truncated?: boolean;
  rowCount?: number;
}

const up = await runtimeUp();
if (!up) {
  // eslint-disable-next-line no-console
  console.warn(`[database] no runtime at ${BASE}; skipping.`);
}

for (const fixture of ENGINES) {
  const configured = up && (Boolean(fixture.material) || Boolean(fixture.connectionId));
  const suite = configured ? describe : describe.skip;
  if (up && !configured) {
    const hint =
      fixture.engine === 'snowflake'
        ? 'METIS_SNOWFLAKE_CONNECTION (an existing connection id), or METIS_SNOWFLAKE_ACCOUNT plus a token or private key'
        : `METIS_${fixture.engine.toUpperCase()}_HOST`;
    // eslint-disable-next-line no-console
    console.warn(`[database] ${fixture.engine} not configured; set ${hint} to run it.`);
  }

  suite(`the data node against ${fixture.engine}`, () => {
    let api: Api;
    let wf: string;
    let connectionId: string;

    /** One data step, run to completion, handing back what the engine returned. */
    const query = async (config: Record<string, unknown>, label = 'query'): Promise<DataOutput> => {
      const step = node(nodeId(), 'data', { connectionId, engine: fixture.engine, ...config }, label);
      const executionId = await startRun(api, wf, [step], []);
      const run = await until(api, executionId, settled, 40000);
      if (run.meta.status !== 'completed') {
        const failure = (run.logs ?? []).filter((l) => l.nodeId === step.id && l.error).at(-1);
        throw new Error(`${fixture.engine} step failed: ${JSON.stringify(failure?.error)}`);
      }
      return (outputOf(run.logs, step.id) ?? {}) as DataOutput;
    };

    /** The same, but expecting the step to fail, handing back the message. */
    const queryExpectingFailure = async (config: Record<string, unknown>): Promise<string> => {
      const step = node(nodeId(), 'data', { connectionId, engine: fixture.engine, ...config }, 'bad query');
      const executionId = await startRun(api, wf, [step], []);
      const run = await until(api, executionId, settled, 40000);
      expect(run.meta.status).not.toBe('completed');
      const failure = (run.logs ?? []).filter((l) => l.nodeId === step.id && l.error).at(-1);
      return JSON.stringify(failure?.error ?? {});
    };

    beforeAll(async () => {
      api = client(await login());
      if (fixture.connectionId) {
        connectionId = fixture.connectionId;
      } else {
        const conn = await api<{ connectionId: string }>('POST', '/api/connections', {
          name: `${fixture.engine} acceptance`,
          connectorId: fixture.connectorId,
          connectionType: 'database',
          authScheme: fixture.authScheme ?? 'database',
          material: fixture.material,
        });
        if (conn.status !== 201) {
          throw new Error(`could not store the ${fixture.engine} connection: ${JSON.stringify(conn.body)}`);
        }
        connectionId = conn.body.connectionId;
      }

      const created = await api<{ workflowId: string }>('POST', '/api/workflows', {
        name: `db-${fixture.engine}-${Date.now()}`,
        type: 'workflow',
        nodes: [node(nodeId(), 'code', { code: 'return { seeded: true };' }, 'seed')],
        edges: [],
      });
      wf = created.body.workflowId;

      for (const statement of fixture.seed ?? []) {
        await query({ query: statement }, 'seed');
      }
    });

    afterAll(async () => {
      await cancelStragglers(api);
      // Only tidy away a connection this suite created. A borrowed one belongs
      // to the operator and must survive the run.
      if (connectionId && !fixture.connectionId) {
        await api('DELETE', `/api/connections/${connectionId}`);
      }
    });

    it('DB-01 a workflow reads real rows out of the database', async () => {
      const out = await query({ query: 'select customer, amount, status from orders order by id' });
      expect(out.rows?.length).toBeGreaterThan(0);
      // The seeded sample data, not an empty success.
      expect(out.rows?.map((r) => String(pick(r, 'customer')))).toContain('Ada Lovelace');
      // `row` is the first record, so a single-result lookup reads cleanly
      // downstream as {{step.data.row.customer}}.
      expect(pick(out.row ?? {}, 'customer')).toBe('Ada Lovelace');
    }, 60000);

    it('DB-02 a parameterised read only returns the matching rows', async () => {
      const out = await query({
        query: `select customer, status from orders where status = ${fixture.placeholder(1)} order by id`,
        params: ['refunded'],
      });
      expect(out.rows?.length).toBeGreaterThan(0);
      expect(out.rows?.every((r) => pick(r, 'status') === 'refunded')).toBe(true);
    }, 60000);

    it.skipIf(!fixture.builder)('DB-03 the visual table builder reads the same rows as hand-written SQL', async () => {
      const built = await query({
        operation: 'select',
        tables: [{ name: 'orders', columns: [{ name: 'customer' }, { name: 'amount' }] }],
        orderBy: [{ column: 'id', direction: 'asc' }],
      });
      const written = await query({ query: 'select customer, amount from orders order by id' });
      expect(built.rows).toEqual(written.rows);
    }, 60000);

    it('DB-04 a write lands and a later read sees it', async () => {
      await query({ query: `drop table if exists ${fixture.scratch}` }, 'clean');
      await query({ query: `create table ${fixture.scratch} (id int, note varchar(64))` }, 'create');
      await query({
        query: `insert into ${fixture.scratch} (id, note) values (${fixture.placeholder(1)}, ${fixture.placeholder(2)})`,
        params: [1, 'written by a workflow'],
      }, 'insert');

      const readBack = await query({ query: `select id, note from ${fixture.scratch}` }, 'read back');
      expect(pick(readBack.row ?? {}, 'note')).toBe('written by a workflow');
      await query({ query: `drop table ${fixture.scratch}` }, 'drop');
    }, 90000);

    it('DB-05 a broken query fails the step with the engine\'s own message', async () => {
      // The honesty case: a typo must not read as a green run with no rows.
      const message = await queryExpectingFailure({ query: 'select * from a_table_that_does_not_exist' });
      expect(message).toMatch(/a_table_that_does_not_exist/i);
    }, 60000);
  });
}

/**
 * The chain an operator actually builds: read from a database, then reshape
 * what came back. Worth its own case because the transform step is only useful
 * if an earlier step's rows can reach it, and that wiring lives in a config
 * field (`inputData`) that has to be discoverable, not folklore.
 */
const readAndShape = process.env.METIS_MYSQL_CONNECTION;
const chain = up && readAndShape ? describe : describe.skip;

chain('a database read feeding a transform', () => {
  let api: Api;
  let wf: string;

  beforeAll(async () => {
    api = client(await login());
    const created = await api<{ workflowId: string }>('POST', '/api/workflows', {
      name: `read-and-shape-${Date.now()}`,
      type: 'workflow',
      nodes: [node(nodeId(), 'code', { code: 'return { seeded: true };' }, 'seed')],
      edges: [],
    });
    wf = created.body.workflowId;
  });

  afterAll(async () => {
    await cancelStragglers(api);
  });

  it('DB-06 rows from a database node reach a transform and are reshaped', async () => {
    const read = node(
      nodeId(),
      'mysql',
      { connectorId: readAndShape, query: 'select customer, amount, status from orders order by id' },
      'read orders',
    );
    // The wiring under test: an earlier step's rows named as this step's input.
    const shape = node(
      nodeId(),
      'transform',
      {
        inputData: `{{${read.id}.data.rows}}`,
        code: `const rows = input ?? [];
               const paid = rows.filter((r) => r.status === 'paid');
               return { orders: rows.length, paidOrders: paid.length,
                        paidTotal: paid.reduce((sum, r) => sum + Number(r.amount), 0) };`,
      },
      'total the paid orders',
    );
    const executionId = await startRun(api, wf, [read, shape], [edge(read.id, shape.id)]);
    const run = await until(api, executionId, settled, 40000);

    expect(run.meta.status).toBe('completed');
    const shaped = outputOf(run.logs, shape.id) as { orders?: number; paidOrders?: number; paidTotal?: number };
    // The seeded sample: six orders, four of them paid.
    expect(shaped.orders).toBe(6);
    expect(shaped.paidOrders).toBe(4);
    expect(shaped.paidTotal).toBeCloseTo(789.5, 2);
  }, 90000);
});
