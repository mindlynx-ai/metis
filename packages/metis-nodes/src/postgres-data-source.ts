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
 * The Postgres DataSource adapter: the open-edition implementation of the
 * DataSourcePort. It owns a small pg.Pool per connection, runs parameterised
 * queries capped at the source (a wrapping LIMIT) and again in memory, and reads
 * the catalog from information_schema for the no-SQL table builder. Athena /
 * Snowflake are the same interface in the Helix build; nothing here is engine-
 * generic beyond the shared cap helper.
 */
import { poolFor } from './postgres-pool.js';
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

/** A single read statement we can safely wrap in a capping subquery. */
export function isWrappableSelect(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) return false; // multiple statements
  return /^(select|with)\b/i.test(trimmed);
}

/** Wrap a read query so at most maxRows+1 rows are fetched (the +1 detects
 * "there were more"), instead of pulling a whole table into memory. */
export function wrapForLimit(sql: string, maxRows: number): string {
  const inner = sql.trim().replace(/;\s*$/, '');
  return `SELECT * FROM (${inner}) AS _capped LIMIT ${maxRows + 1}`;
}

// Common Postgres type OIDs -> a friendly name. The wire protocol reports a
// column's type as an OID, not a name; unknown OIDs fall back to 'unknown'.
const PG_TYPE_BY_OID: Record<number, string> = {
  16: 'boolean',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  114: 'json',
  700: 'real',
  701: 'double',
  1043: 'varchar',
  1082: 'date',
  1114: 'timestamp',
  1184: 'timestamptz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
};

/** The columns a query result declares, from pg's field descriptors. Pure, so
 *  the OID -> name mapping is unit-testable without a database. */
export function columnsFromFields(fields: { name: string; dataTypeID: number }[]): DataColumn[] {
  return fields.map((field) => ({ name: field.name, type: PG_TYPE_BY_OID[field.dataTypeID] ?? 'unknown' }));
}

export class PostgresDataSource implements DataSource {
  readonly engine = 'postgres';

  async runQuery(
    connection: DataConnection,
    sql: string,
    options: QueryOptions = {},
  ): Promise<QueryResult> {
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    const pool = poolFor(connection.key, connection.material);
    const params = options.params ?? [];
    // Wrap read queries so the source caps the fetch; write queries (INSERT ...
    // RETURNING) return small result sets, so run them as-is.
    const wrap = params.length === 0 && isWrappableSelect(sql);
    const text = wrap ? wrapForLimit(sql, maxRows) : sql;
    const result = await pool.query(text, params);
    return capRows(result.rows as Record<string, unknown>[], {
      maxRows,
      maxBytes: options.maxBytes,
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
    const pool = poolFor(connection.key, connection.material);
    const inner = sql.trim().replace(/;\s*$/, '');
    // LIMIT 0: the planner validates every table/column/join/type reference but
    // returns no rows - a describe, not a fetch.
    const result = await pool.query(`SELECT * FROM (${inner}) AS _describe LIMIT 0`, options.params ?? []);
    return columnsFromFields(result.fields as { name: string; dataTypeID: number }[]);
  }

  async listTables(
    connection: DataConnection,
    options: { schema?: string } = {},
  ): Promise<DataTable[]> {
    const pool = poolFor(connection.key, connection.material);
    const result = await pool.query(
      `SELECT table_schema, table_name
         FROM information_schema.tables
        WHERE table_type IN ('BASE TABLE', 'VIEW')
          AND table_schema NOT IN ('pg_catalog', 'information_schema')
          AND ($1::text IS NULL OR table_schema = $1)
        ORDER BY table_schema, table_name`,
      [options.schema ?? null],
    );
    return result.rows.map((row) => ({
      name: String(row.table_name),
      schema: String(row.table_schema),
    }));
  }

  async describeTable(
    connection: DataConnection,
    table: string,
    options: { schema?: string } = {},
  ): Promise<DataColumn[]> {
    const pool = poolFor(connection.key, connection.material);
    const result = await pool.query(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_name = $1
          AND ($2::text IS NULL OR table_schema = $2)
        ORDER BY ordinal_position`,
      [table, options.schema ?? null],
    );
    return result.rows.map((row) => ({
      name: String(row.column_name),
      type: String(row.data_type),
    }));
  }
}
