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
 * The MySQL DataSource: the second open-edition implementation of the
 * DataSourcePort, and the one that proves the seam is genuinely engine-generic
 * rather than Postgres wearing an interface.
 *
 * Two differences from Postgres worth knowing, both handled here:
 *   - Placeholders are `?`, not `$1`. Hand-written SQL is the author's own
 *     dialect and is passed through untouched; only the visual builder is
 *     generated, and it asks the dialect which style to emit.
 *   - MySQL has no schema layer above the database: `information_schema`'s
 *     `table_schema` IS the database name, so an unqualified table lookup is
 *     scoped to the connection's own database rather than to `public`.
 */
import { mysqlPoolFor } from './mysql-pool.js';
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

/** mysql2 reports a column's type as a numeric code; name the common ones. */
const MYSQL_TYPE_BY_CODE: Record<number, string> = {
  0: 'decimal',
  1: 'tinyint',
  2: 'smallint',
  3: 'integer',
  4: 'float',
  5: 'double',
  7: 'timestamp',
  8: 'bigint',
  9: 'mediumint',
  10: 'date',
  11: 'time',
  12: 'datetime',
  13: 'year',
  15: 'varchar',
  16: 'bit',
  245: 'json',
  246: 'decimal',
  252: 'blob',
  253: 'varchar',
  254: 'char',
};

interface MysqlField {
  name: string;
  type?: number;
}

export function columnsFromMysqlFields(fields: MysqlField[]): DataColumn[] {
  return fields.map((field) => ({
    name: field.name,
    type: field.type === undefined ? 'unknown' : (MYSQL_TYPE_BY_CODE[field.type] ?? 'unknown'),
  }));
}

/** Wrap a read so the server caps the fetch. MySQL needs the derived table
 *  aliased, exactly as Postgres does. */
export function wrapForMysqlLimit(sql: string, maxRows: number): string {
  const inner = sql.trim().replace(/;\s*$/, '');
  return `SELECT * FROM (${inner}) AS _capped LIMIT ${maxRows + 1}`;
}

export class MysqlDataSource implements DataSource {
  readonly engine = 'mysql';

  async runQuery(
    connection: DataConnection,
    sql: string,
    options: QueryOptions = {},
  ): Promise<QueryResult> {
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    const pool = mysqlPoolFor(connection.key, connection.material);
    const params = options.params ?? [];
    const wrap = params.length === 0 && isWrappableSelect(sql);
    const text = wrap ? wrapForMysqlLimit(sql, maxRows) : sql;
    const [rows] = await pool.query(text, params);
    // A write (INSERT/UPDATE/DDL) answers with a ResultSetHeader, not an array.
    // Report it as an empty result rather than pretending it returned records.
    if (!Array.isArray(rows)) {
      return { rows: [], rowCount: 0, truncated: false };
    }
    return capRows(rows as Record<string, unknown>[], {
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
    const pool = mysqlPoolFor(connection.key, connection.material);
    const inner = sql.trim().replace(/;\s*$/, '');
    // LIMIT 0 validates every table/column/type reference and returns no rows.
    const [, fields] = await pool.query(
      `SELECT * FROM (${inner}) AS _describe LIMIT 0`,
      options.params ?? [],
    );
    return columnsFromMysqlFields((fields ?? []) as unknown as MysqlField[]);
  }

  async listTables(
    connection: DataConnection,
    options: { schema?: string } = {},
  ): Promise<DataTable[]> {
    const pool = mysqlPoolFor(connection.key, connection.material);
    // DATABASE() keeps the default scoped to the connection's own database
    // instead of listing every schema on the server.
    const [rows] = await pool.query(
      `SELECT table_schema, table_name
         FROM information_schema.tables
        WHERE table_type IN ('BASE TABLE', 'VIEW')
          AND table_schema = COALESCE(?, DATABASE())
        ORDER BY table_schema, table_name`,
      [options.schema ?? null],
    );
    return (rows as Record<string, unknown>[]).map((row) => ({
      name: String(row.TABLE_NAME ?? row.table_name),
      schema: String(row.TABLE_SCHEMA ?? row.table_schema),
    }));
  }

  async describeTable(
    connection: DataConnection,
    table: string,
    options: { schema?: string } = {},
  ): Promise<DataColumn[]> {
    const pool = mysqlPoolFor(connection.key, connection.material);
    const [rows] = await pool.query(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_name = ?
          AND table_schema = COALESCE(?, DATABASE())
        ORDER BY ordinal_position`,
      [table, options.schema ?? null],
    );
    return (rows as Record<string, unknown>[]).map((row) => ({
      name: String(row.COLUMN_NAME ?? row.column_name),
      type: String(row.DATA_TYPE ?? row.data_type),
    }));
  }
}
