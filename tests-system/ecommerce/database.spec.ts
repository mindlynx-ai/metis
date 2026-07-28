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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, client, login, node, nodeId, runtimeUp } from '../harness.js';
import { cancelStragglers, outputOf, settled, startRun, until, type Api } from './shop.js';

/** Credentials for one engine, or undefined when it is not configured. */
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

interface EngineFixture {
  /** The engine the data node dispatches on. */
  engine: string;
  /** The connector record a connection is created against. */
  connectorId: string;
  material?: Record<string, string>;
  /** A scratch table name this engine's cases create and drop. */
  scratch: string;
  /** Hand-written SQL stays the author's own dialect, so the cases bind the
   *  way the engine does: $1 for Postgres, ? for MySQL. */
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
    engine: 'snowflake',
    connectorId: 'snowflake',
    material: material('METIS_SNOWFLAKE'),
    scratch: 'METIS_PROBE_SF',
    placeholder: (index) => `:${index}`,
    builder: false,
  },
];

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
  const configured = up && Boolean(fixture.material);
  const suite = configured ? describe : describe.skip;
  if (up && !fixture.material) {
    // eslint-disable-next-line no-console
    console.warn(`[database] ${fixture.engine} not configured; set METIS_${fixture.engine.toUpperCase()}_HOST to run it.`);
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
      const conn = await api<{ connectionId: string }>('POST', '/api/connections', {
        name: `${fixture.engine} acceptance`,
        connectorId: fixture.connectorId,
        connectionType: 'database',
        authScheme: 'database',
        material: fixture.material,
      });
      if (conn.status !== 201) {
        throw new Error(`could not store the ${fixture.engine} connection: ${JSON.stringify(conn.body)}`);
      }
      connectionId = conn.body.connectionId;

      const created = await api<{ workflowId: string }>('POST', '/api/workflows', {
        name: `db-${fixture.engine}-${Date.now()}`,
        type: 'workflow',
        nodes: [node(nodeId(), 'code', { code: 'return { seeded: true };' }, 'seed')],
        edges: [],
      });
      wf = created.body.workflowId;
    });

    afterAll(async () => {
      await cancelStragglers(api);
      if (connectionId) await api('DELETE', `/api/connections/${connectionId}`);
    });

    it('DB-01 a workflow reads real rows out of the database', async () => {
      const out = await query({ query: 'select customer, amount, status from orders order by id' });
      expect(out.rows?.length).toBeGreaterThan(0);
      // The seeded sample data, not an empty success.
      expect(out.rows?.map((r) => String(r.customer))).toContain('Ada Lovelace');
      // `row` is the first record, so a single-result lookup reads cleanly
      // downstream as {{step.data.row.customer}}.
      expect(out.row?.customer).toBe('Ada Lovelace');
    }, 60000);

    it('DB-02 a parameterised read only returns the matching rows', async () => {
      const out = await query({
        query: `select customer, status from orders where status = ${fixture.placeholder(1)} order by id`,
        params: ['refunded'],
      });
      expect(out.rows?.length).toBeGreaterThan(0);
      expect(out.rows?.every((r) => r.status === 'refunded')).toBe(true);
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
      expect(readBack.row?.note).toBe('written by a workflow');
      await query({ query: `drop table ${fixture.scratch}` }, 'drop');
    }, 90000);

    it('DB-05 a broken query fails the step with the engine\'s own message', async () => {
      // The honesty case: a typo must not read as a green run with no rows.
      const message = await queryExpectingFailure({ query: 'select * from a_table_that_does_not_exist' });
      expect(message).toMatch(/a_table_that_does_not_exist/i);
    }, 60000);
  });
}
