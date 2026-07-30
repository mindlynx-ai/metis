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
 * The SQL Server DataSource. Until this landed, `sqlserver` was a catalogue
 * record with nowhere to go: its credentials could be stored and nothing could
 * query it.
 *
 * Four things differ from Postgres and MySQL, and each one is a wrong answer
 * rather than an error if it is got wrong:
 *   - There is no LIMIT. The row cap is a TOP, and TOP sits in front of the
 *     columns, so it is injected rather than wrapped around (see capAtSource).
 *   - The driver binds by NAME, not position, so a workflow's positional params
 *     become @p1, @p2 ... which is what the dialect emits too.
 *   - Identifiers bracket as [name], the only dialect here whose quotes are not
 *     the same character twice.
 *   - A describe is a system procedure, not a LIMIT 0 wrap, because a derived
 *     table refuses to hold a query that has its own ORDER BY.
 *
 * The driver is OPTIONAL, and loaded through createRequire the way the code
 * node loads isolated-vm and the sqlite adapter loads node:sqlite. `mssql`
 * reaches `tedious`, which reaches `@azure/identity` and a browser MSAL bundle:
 * 60 MB installed, for SQL Server AD auth almost no self-hoster uses. Anyone who
 * does not want it installs with `--omit=optional`, and the engine then degrades
 * to `locked` the same way athena does, rather than throwing.
 */
import { createRequire } from 'node:module';
import type mssqlType from 'mssql';
import { isWrappableSelect } from './postgres-data-source.js';
import {
  capRows,
  DEFAULT_MAX_ROWS,
  type DataColumn,
  type DataConnection,
  type DataSource,
  type DataTable,
  type QueryOptions,
  type QueryResult,
} from '@mindlynx/metis-ports';

const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_PORT = 1433;

const requireModule = createRequire(import.meta.url);
let driver: typeof mssqlType | undefined;

/** The driver, loaded on first use. Only reached from an adapter that
 *  loadSqlServer already resolved, so a throw here is a broken install, not an
 *  absent optional dependency. */
function mssql(): typeof mssqlType {
  driver ??= requireModule('mssql') as typeof mssqlType;
  return driver;
}

/**
 * Is the driver installed? Answered by RESOLVING rather than loading, so asking
 * costs nothing and cannot half-initialise a module. `undefined` means the
 * adapter is not registered, which is the existing "no open adapter" path: the
 * inspector shows `locked` and falls back to a typed table name, the connection
 * tester says connect-only, and the node reports the upgrade response. Every one
 * of those already existed for athena.
 */
export function loadSqlServer(
  resolve: (id: string) => string = (id: string) => requireModule.resolve(id),
): SqlServerDataSource | undefined {
  try {
    resolve('mssql');
    return new SqlServerDataSource();
  } catch {
    return undefined;
  }
}

/**
 * One pool per connection, as the Postgres and MySQL adapters keep. Connecting
 * is asynchronous here, unlike theirs, so the cache holds the PROMISE: two
 * steps starting at once share one pool instead of racing two into existence.
 * A failed connect is evicted, or a single mistyped password would be
 * remembered for the life of the worker.
 */
const pools = new Map<string, Promise<mssqlType.ConnectionPool>>();

function sqlServerPoolFor(
  key: string,
  material: Record<string, string>,
): Promise<mssqlType.ConnectionPool> {
  const existing = pools.get(key);
  if (existing) return existing;
  const opening = new (mssql().ConnectionPool)({
    server: material.host ?? '',
    port: material.port ? Number(material.port) : DEFAULT_PORT,
    database: material.database || undefined,
    user: material.user || undefined,
    password: material.password || undefined,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    pool: { max: 5, idleTimeoutMillis: 5 * 60 * 1000 },
    options: {
      // TLS stays on, as the driver has it. Trusting the certificate is the
      // escape hatch for the self-signed one a SQL Server presents until
      // somebody installs a real one: an operator opts into that per
      // connection, and never quietly on their behalf.
      trustServerCertificate: material.trustServerCertificate === 'true',
    },
  }).connect();
  opening.catch(() => pools.delete(key));
  pools.set(key, opening);
  return opening;
}

/** Statement shapes a leading TOP would answer differently rather than cap:
 *  TOP binds to the FIRST query of a set operation instead of the whole
 *  result, and cannot appear alongside OFFSET/FETCH at all. */
const NO_TOP = /\b(union|except|intersect|top|offset)\b/i;
const SELECT_HEAD = /^select\s+(distinct\s+|all\s+)?/i;

/**
 * Cap a read at the server. The other adapters wrap the query in a derived
 * table and LIMIT that, which is exactly wrong here twice over: SQL Server has
 * no LIMIT, and a derived table REFUSES a query that carries its own ORDER BY
 * unless that inner query also has a TOP. So the cap is injected in front of
 * the columns instead. A statement TOP cannot safely cap is handed back
 * untouched and capRows still guards the payload.
 */
export function capAtSource(sql: string, maxRows: number): string {
  const inner = sql.trim().replace(/;\s*$/, '');
  if (NO_TOP.test(inner)) return inner;
  const head = SELECT_HEAD.exec(inner);
  if (!head) return inner;
  return `${head[0]}TOP (${maxRows + 1}) ${inner.slice(head[0].length)}`;
}

/** The positional params a workflow supplies, under the names the driver binds
 *  by and the dialect emits: $1 elsewhere is @p1 here. */
export function namedParams(params: unknown[]): Record<string, unknown> {
  return Object.fromEntries(params.map((value, index) => [`p${index + 1}`, value]));
}

/** The declaration sp_describe_first_result_set needs before it will parse a
 *  statement that binds values: undeclared placeholders fail a describe on a
 *  query that would run perfectly. sql_variant accepts whatever is bound. */
export function paramDeclaration(count: number): string | null {
  if (count === 0) return null;
  return Array.from({ length: count }, (_, index) => `@p${index + 1} sql_variant`).join(', ');
}

export class SqlServerDataSource implements DataSource {
  readonly engine = 'sqlserver';

  private async run(
    connection: DataConnection,
    sql: string,
    inputs: Record<string, unknown> = {},
  ): Promise<mssqlType.IResult<Record<string, unknown>>> {
    const pool = await sqlServerPoolFor(connection.key, connection.material);
    const request = pool.request();
    for (const [name, value] of Object.entries(inputs)) request.input(name, value);
    return request.query<Record<string, unknown>>(sql);
  }

  async runQuery(
    connection: DataConnection,
    sql: string,
    options: QueryOptions = {},
  ): Promise<QueryResult> {
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    const params = options.params ?? [];
    const text = params.length === 0 && isWrappableSelect(sql) ? capAtSource(sql, maxRows) : sql;
    const result = await this.run(connection, text, namedParams(params));
    // A write (INSERT/UPDATE/DDL) answers with rowsAffected and no recordset at
    // all. Report that as an empty result rather than inventing records for it.
    return capRows(result.recordset ?? [], { maxRows, maxBytes: options.maxBytes });
  }

  async describeQuery(
    connection: DataConnection,
    sql: string,
    options: QueryOptions = {},
  ): Promise<DataColumn[]> {
    if (!isWrappableSelect(sql)) {
      throw new Error('only a single SELECT can be validated for its columns');
    }
    // sp_describe_first_result_set is SQL Server's own describe: it returns the
    // columns a statement WOULD produce and raises the real error for a bad
    // column or join, without running it. The LIMIT 0 wrap the other adapters
    // use is unavailable here, because the wrap is the thing SQL Server refuses.
    const result = await this.run(
      connection,
      'EXEC sp_describe_first_result_set @tsql = @tsql, @params = @params',
      {
        tsql: sql.trim().replace(/;\s*$/, ''),
        params: paramDeclaration((options.params ?? []).length),
      },
    );
    return (result.recordset ?? []).map((row) => ({
      name: String(row.name),
      type: String(row.system_type_name),
    }));
  }

  async listTables(
    connection: DataConnection,
    options: { schema?: string } = {},
  ): Promise<DataTable[]> {
    // INFORMATION_SCHEMA is per-database in SQL Server, so this is already
    // scoped to the connection's own database and only the schema needs a
    // filter. The server's own schemas hold nothing a workflow queries.
    const result = await this.run(
      connection,
      `SELECT TABLE_SCHEMA, TABLE_NAME
         FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
          AND TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')
          AND (@schema IS NULL OR TABLE_SCHEMA = @schema)
        ORDER BY TABLE_SCHEMA, TABLE_NAME`,
      { schema: options.schema ?? null },
    );
    return (result.recordset ?? []).map((row) => ({
      name: String(row.TABLE_NAME),
      schema: String(row.TABLE_SCHEMA),
    }));
  }

  async describeTable(
    connection: DataConnection,
    table: string,
    options: { schema?: string } = {},
  ): Promise<DataColumn[]> {
    const result = await this.run(
      connection,
      `SELECT COLUMN_NAME, DATA_TYPE
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = @table
          AND (@schema IS NULL OR TABLE_SCHEMA = @schema)
        ORDER BY ORDINAL_POSITION`,
      { table, schema: options.schema ?? null },
    );
    return (result.recordset ?? []).map((row) => ({
      name: String(row.COLUMN_NAME),
      type: String(row.DATA_TYPE),
    }));
  }
}
