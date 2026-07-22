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
 * The data-source port: the seam that makes the "Data" node engine-agnostic. A
 * connection's engine (postgres today; athena/snowflake later, in the Helix
 * build) resolves to a DataSource adapter, and the node talks to this interface
 * only - it never names Postgres. Adapters register into a DataSourceRegistry,
 * exactly like NodeHandlerRegistry / the credential + gateway ports.
 */

/** The default inline-result ceiling. A result over EITHER cap is truncated,
 * because a node's whole output rides the workflow state through Temporal's
 * ~2 MB payload limit on every hop. Larger data belongs in a dataset
 * reference, not inline. */
export const DEFAULT_MAX_ROWS = 1000;
export const DEFAULT_MAX_BYTES = 256 * 1024;

/** A connection resolved for a query: a stable key for pooling + auth material. */
export interface DataConnection {
  /** Stable pool key, e.g. `${tenantId}/${connectionId}`. */
  key: string;
  /** Resolved auth material (host/port/database/user/password, or a token). */
  material: Record<string, string>;
}

export interface DataColumn {
  name: string;
  type?: string;
}

export interface DataTable {
  name: string;
  schema?: string;
}

export interface QueryOptions {
  /** Parameter values for $1, $2 ... placeholders. */
  params?: unknown[];
  maxRows?: number;
  maxBytes?: number;
}

/** A query result, capped for inline use. `truncated` means more rows existed. */
export interface QueryResult {
  rows: Record<string, unknown>[];
  /** Rows actually returned (after the cap). */
  rowCount: number;
  /** Total rows the query produced, when the engine reports it. */
  totalRows?: number;
  truncated: boolean;
}

/**
 * A pointer to data that lives at the source - handed downstream instead of the
 * rows themselves, so it never hits the payload ceiling and a later step can
 * materialise it on demand. This is also the shape warehouse-scale engines return.
 */
export interface DatasetRef {
  kind: 'dataset';
  connectionId: string;
  engine: string;
  table?: string;
  query?: string;
  schema?: DataColumn[];
}

/** One engine's implementation. Adapters cache their own pools/clients. */
export interface DataSource {
  readonly engine: string;
  runQuery(connection: DataConnection, sql: string, options?: QueryOptions): Promise<QueryResult>;
  listTables(connection: DataConnection, options?: { schema?: string }): Promise<DataTable[]>;
  describeTable(
    connection: DataConnection,
    table: string,
    options?: { schema?: string },
  ): Promise<DataColumn[]>;
  /** Validate a read query and return the columns it produces, WITHOUT pulling
   *  rows (a describe). Throws on any SQL error - a bad join/column/type - which
   *  is exactly how the editor validates a hand-written query. Optional: an
   *  engine that cannot describe simply does not offer validation. */
  describeQuery?(
    connection: DataConnection,
    sql: string,
    options?: QueryOptions,
  ): Promise<DataColumn[]>;
}

/** A small registry the Data node dispatches through, keyed by engine. */
export class DataSourceRegistry {
  private readonly sources = new Map<string, DataSource>();

  register(source: DataSource): this {
    this.sources.set(source.engine, source);
    return this;
  }

  get(engine: string): DataSource | undefined {
    return this.sources.get(engine);
  }

  engines(): string[] {
    return [...this.sources.keys()].sort();
  }
}

/**
 * Cap already-fetched rows to the row + byte ceiling (engine-agnostic). Prefer
 * capping at the source (a LIMIT) too, so millions of rows are never fetched;
 * this is the final in-memory guard. `total` is the engine's reported row count
 * when known (so `truncated` is honest even if the source already limited).
 */
export function capRows(
  rows: Record<string, unknown>[],
  options: { maxRows?: number; maxBytes?: number; total?: number } = {},
): QueryResult {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let kept = rows.length > maxRows ? rows.slice(0, maxRows) : rows;
  // Trim further if the serialised rows exceed the byte cap: drop ~10% each pass
  // (a single oversized row converges to zero, which is correct - it can't fit).
  while (kept.length > 0 && Buffer.byteLength(JSON.stringify(kept)) > maxBytes) {
    kept = kept.slice(0, Math.floor(kept.length * 0.9));
  }
  // totalRows is only reported when the caller knows the real count; a source
  // LIMIT that just detects "there were more" leaves it undefined.
  const truncated =
    kept.length < rows.length || (options.total !== undefined && kept.length < options.total);
  return { rows: kept, rowCount: kept.length, totalRows: options.total, truncated };
}
