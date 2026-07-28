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
 * The Snowflake DataSource, over the SQL REST API v2 rather than the official
 * driver. `snowflake-sdk` pulls a large native dependency tree into what is an
 * Apache-2.0 build, for a warehouse that already exposes plain JSON over HTTPS.
 *
 * Three things differ from a wire-protocol database and shape this adapter:
 *   - Authentication is never a password. It is either a programmatic access
 *     token (a string the account issues, simplest to set up) or a short-lived
 *     JWT signed with a key pair (see snowflake-jwt.ts, cached until shortly
 *     before it expires). A connection supplies whichever it has.
 *   - A result arrives as arrays of strings plus separate column metadata, so
 *     rows are assembled here and numeric columns are converted back.
 *   - A statement that outruns the synchronous window answers 202 with a
 *     handle, and the real result has to be collected by polling.
 */
import { randomUUID } from 'node:crypto';
import { isWrappableSelect } from './postgres-data-source.js';
import { snowflakeJwt, JWT_LIFETIME_SECONDS } from './snowflake-jwt.js';
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

/** Refresh a token this long before it actually expires. */
const TOKEN_SKEW_SECONDS = 60;
/** How long to keep collecting an asynchronous statement before giving up. */
const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1_000;

interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokens = new Map<string, CachedToken>();

/** Drop every cached token (shutdown, and the seam a test resets through). */
export function clearSnowflakeTokens(): void {
  tokens.clear();
}

/** The account's REST host. An explicit accountUrl wins, so a private link or
 *  a non-standard domain can be pointed at without code changes. */
export function snowflakeHost(material: Record<string, string>): string {
  const explicit = material.accountUrl?.trim();
  if (explicit) {
    let trimmed = explicit;
    while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
    return trimmed;
  }
  const account = (material.account ?? '').trim().toLowerCase();
  return `https://${account}.snowflakecomputing.com`;
}

/** The bearer token and the type header that names how it was made. */
export interface SnowflakeAuth {
  token: string;
  type: 'PROGRAMMATIC_ACCESS_TOKEN' | 'KEYPAIR_JWT';
}

/**
 * A programmatic access token is used as-is: the account issued it, it already
 * identifies the user and role, and there is nothing to sign or cache. A key
 * pair mints a JWT instead, held until just before it expires.
 */
export function authFor(connection: DataConnection): SnowflakeAuth {
  const pat = connection.material.token?.trim();
  if (pat) return { token: pat, type: 'PROGRAMMATIC_ACCESS_TOKEN' };

  const cached = tokens.get(connection.key);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - TOKEN_SKEW_SECONDS > now) {
    return { token: cached.token, type: 'KEYPAIR_JWT' };
  }
  const token = snowflakeJwt({
    account: connection.material.account ?? '',
    user: connection.material.user ?? '',
    privateKey: connection.material.privateKey ?? '',
    passphrase: connection.material.passphrase || undefined,
  });
  tokens.set(connection.key, { token, expiresAt: now + JWT_LIFETIME_SECONDS });
  return { token, type: 'KEYPAIR_JWT' };
}

/** Snowflake reports a column's type in its own vocabulary; keep it, but name
 *  the ones that decide whether a value is parsed back out of its string. */
const NUMERIC_TYPES = new Set(['fixed', 'real']);

interface RowType {
  name: string;
  type: string;
}

interface StatementResponse {
  code?: string;
  message?: string;
  statementHandle?: string;
  statementStatusUrl?: string;
  resultSetMetaData?: { numRows?: number; rowType?: RowType[] };
  data?: unknown[][];
}

/** Assemble the row objects a workflow reads from the API's column-and-array
 *  form, converting numbers back out of the strings the wire carries. */
export function rowsFromResponse(response: StatementResponse): Record<string, unknown>[] {
  const rowType = response.resultSetMetaData?.rowType ?? [];
  return (response.data ?? []).map((values) => {
    const row: Record<string, unknown> = {};
    rowType.forEach((column, index) => {
      const raw = values[index];
      if (raw === null || raw === undefined) {
        row[column.name] = null;
        return;
      }
      const isNumeric = NUMERIC_TYPES.has(String(column.type).toLowerCase());
      const parsed = isNumeric ? Number(raw) : raw;
      row[column.name] = isNumeric && Number.isNaN(parsed as number) ? raw : parsed;
    });
    return row;
  });
}

/** Snowflake's name for a bound value's type. Anything not obviously a number
 *  or a flag is sent as text, which the server coerces against the column. */
function bindingType(value: unknown): string {
  if (typeof value === 'number') return 'FIXED';
  if (typeof value === 'boolean') return 'BOOLEAN';
  return 'TEXT';
}

/** Positional bindings for the `?` placeholders in a statement. */
export function bindingsFor(params: unknown[]): Record<string, { type: string; value: string }> {
  const bindings: Record<string, { type: string; value: string }> = {};
  params.forEach((value, index) => {
    bindings[String(index + 1)] = { type: bindingType(value), value: String(value) };
  });
  return bindings;
}

export class SnowflakeDataSource implements DataSource {
  readonly engine = 'snowflake';

  private async call(
    connection: DataConnection,
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<StatementResponse> {
    const host = snowflakeHost(connection.material);
    const auth = authFor(connection);
    const res = await fetch(`${host}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${auth.token}`,
        'x-snowflake-authorization-token-type': auth.type,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'metis',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    let parsed: StatementResponse = {};
    try {
      parsed = text ? (JSON.parse(text) as StatementResponse) : {};
    } catch {
      throw new Error(`snowflake answered ${res.status} with a non-JSON body`);
    }
    // A refusal is an error the run can act on, not an empty success.
    if (res.status >= 400) {
      const reason = parsed.message ?? `request failed with ${res.status}`;
      throw new Error(`snowflake: ${reason}`);
    }
    // 202 means the statement outran the synchronous window: collect it.
    if (res.status === 202 && parsed.statementHandle) {
      return this.collect(connection, parsed.statementHandle);
    }
    return parsed;
  }

  /** Poll an asynchronous statement until it produces a result or the wait
   *  runs out. Without this a slow warehouse looks like an empty answer. */
  private async collect(connection: DataConnection, handle: string): Promise<StatementResponse> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const host = snowflakeHost(connection.material);
      const statementUrl = `${host}/api/v2/statements/${encodeURIComponent(handle)}`;
      const auth = authFor(connection);
      const res = await fetch(
        statementUrl,
        {
          headers: {
            authorization: `Bearer ${auth.token}`,
            'x-snowflake-authorization-token-type': auth.type,
            accept: 'application/json',
            'user-agent': 'metis',
          },
        },
      );
      if (res.status === 202) continue;
      const parsed = (await res.json()) as StatementResponse;
      if (res.status >= 400) {
        const reason = parsed.message ?? `statement failed with ${res.status}`;
        throw new Error(`snowflake: ${reason}`);
      }
      return parsed;
    }
    throw new Error(`snowflake: statement ${handle} did not finish within ${POLL_TIMEOUT_MS / 1000}s`);
  }

  private async statement(
    connection: DataConnection,
    sql: string,
    options: QueryOptions = {},
  ): Promise<StatementResponse> {
    const material = connection.material;
    const params = options.params ?? [];
    return this.call(connection, `/api/v2/statements?requestId=${randomUUID()}`, {
      method: 'POST',
      body: {
        statement: sql,
        timeout: 60,
        database: material.database || undefined,
        schema: material.schema || undefined,
        warehouse: material.warehouse || undefined,
        role: material.role || undefined,
        ...(params.length > 0 ? { bindings: bindingsFor(params) } : {}),
      },
    });
  }

  async runQuery(
    connection: DataConnection,
    sql: string,
    options: QueryOptions = {},
  ): Promise<QueryResult> {
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    const params = options.params ?? [];
    // Cap the fetch at the warehouse where we safely can, so a wide table is
    // never dragged across the wire only to be trimmed here.
    const wrap = params.length === 0 && isWrappableSelect(sql);
    const inner = sql.trim().replace(/;\s*$/, '');
    const text = wrap ? `SELECT * FROM (${inner}) LIMIT ${maxRows + 1}` : sql;
    const response = await this.statement(connection, text, options);
    return capRows(rowsFromResponse(response), {
      maxRows,
      maxBytes: options.maxBytes,
      total: response.resultSetMetaData?.numRows,
    });
  }

  async describeQuery(
    connection: DataConnection,
    sql: string,
    options: QueryOptions = {},
  ): Promise<DataColumn[]> {
    if (!isWrappableSelect(sql)) {
      throw new Error('only a single SELECT can be validated for its columns');
    }
    const inner = sql.trim().replace(/;\s*$/, '');
    const response = await this.statement(connection, `SELECT * FROM (${inner}) LIMIT 0`, options);
    return (response.resultSetMetaData?.rowType ?? []).map((column) => ({
      name: column.name,
      type: column.type,
    }));
  }

  async listTables(
    connection: DataConnection,
    options: { schema?: string } = {},
  ): Promise<DataTable[]> {
    const schema = options.schema ?? connection.material.schema ?? '';
    const response = await this.statement(
      connection,
      `SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_type IN ('BASE TABLE', 'VIEW')
          AND (? = '' OR table_schema = ?)
        ORDER BY table_schema, table_name`,
      { params: [schema, schema] },
    );
    return rowsFromResponse(response).map((row) => ({
      name: String(row.TABLE_NAME ?? row.table_name),
      schema: String(row.TABLE_SCHEMA ?? row.table_schema),
    }));
  }

  async describeTable(
    connection: DataConnection,
    table: string,
    options: { schema?: string } = {},
  ): Promise<DataColumn[]> {
    const schema = options.schema ?? connection.material.schema ?? '';
    const response = await this.statement(
      connection,
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = ? AND (? = '' OR table_schema = ?)
        ORDER BY ordinal_position`,
      { params: [table.toUpperCase(), schema, schema] },
    );
    return rowsFromResponse(response).map((row) => ({
      name: String(row.COLUMN_NAME ?? row.column_name),
      type: String(row.DATA_TYPE ?? row.data_type),
    }));
  }
}
