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
 * The narrowing vocabulary a handle and a step share. These are deliberately the
 * visual builder's OWN field names (`operator`, not `op`; `descending`, not
 * `desc`), so a step's where/orderBy/columns arrays travel into a handle and back
 * out again with no mapping layer in between - a mapping layer is a second place
 * for the two to disagree about what a filter means.
 *
 * Declared here rather than beside the builder because a handle is a wire shape:
 * the node composes one, and a warehouse-scale engine composes one too. The
 * builder lives in metis-nodes, and metis-nodes imports metis-ports, never the
 * other way round, so this is the only end of that edge both can reach.
 */
export interface NarrowColumn {
  name: string;
  alias?: string;
}
export interface NarrowWhere {
  table?: string;
  column: string;
  operator: string;
  value: unknown;
}
export interface NarrowOrderBy {
  table?: string;
  column: string;
  direction?: 'ascending' | 'descending';
}

/** The narrowing a handle carries. Every field optional: absent means "no
 *  narrowing", i.e. the whole table. */
export interface DatasetNarrow {
  columns?: NarrowColumn[];
  where?: NarrowWhere[];
  orderBy?: NarrowOrderBy[];
  limit?: number;
}

/**
 * A pointer to data that lives at the source - handed downstream instead of the
 * rows themselves, so it never hits the payload ceiling and a later step can
 * materialise it on demand. This is also the shape warehouse-scale engines return.
 *
 * It comes in two forms, told apart by which field is set:
 *
 * - SPEC (`table` + optional `narrow`): the INGREDIENTS. A later step merges its
 *   own filter into `narrow` and composes one flat SELECT.
 * - RAW (`query`): a hand-written query, which is genuinely all that is known
 *   about it - nobody named the table, the columns, or which predicate is the
 *   filter. It can be opened, and narrowed LOCALLY by wrapping it as a derived
 *   table.
 *
 * Why the spec form exists at all: an engine that has to prove every query it
 * runs is scoped to one account cannot accept a derived table. A predicate in one
 * branch is no proof a sibling branch is scoped, so counting predicates is
 * unsound and any subquery is refused before predicates are even considered.
 * That is an isolation invariant, not a limitation waiting to be lifted, so a
 * handle bound for such an engine carries ingredients and every reader composes
 * ONE flat statement from them.
 */
export interface DatasetRef {
  kind: 'dataset';
  /** Empty on a handle a cloud engine produced: the account supplies the
   *  warehouse, so there is no connection to name. */
  connectionId: string;
  engine: string;
  table?: string;
  narrow?: DatasetNarrow;
  query?: string;
  schema?: DataColumn[];
}

/** The narrowing a STEP asks for, in the builder's own shape - its columns hang
 *  off the first table rather than sitting at the top level. */
export interface StepNarrowing {
  where?: NarrowWhere[];
  orderBy?: NarrowOrderBy[];
  limit?: number;
  tables?: { columns?: NarrowColumn[] }[];
}

/** True when a step asks for anything narrower than the whole handle. Lives here
 *  for the same reason as asDatasetRef: the cloud-bind guard has to read "does
 *  this step filter" exactly as the node does, or it would refuse a different set
 *  of steps than the ones that cannot work. */
export function narrowsHandle(config: StepNarrowing): boolean {
  return Boolean(
    (config.where && config.where.length > 0) ||
      (config.orderBy && config.orderBy.length > 0) ||
      (typeof config.limit === 'number' && config.limit > 0) ||
      ((config.tables ?? [])[0]?.columns ?? []).length > 0,
  );
}

/** Coerce a config value into a DatasetRef, whether it came through as an object
 *  or, because it was templated into a text field, as that object's JSON string.
 *  Lives here rather than in the Data node because the cloud-bind guard reads the
 *  same field: if the two disagreed about what a handle is, a step could bind to
 *  the cloud carrying a connection the guard never saw. */
export function asDatasetRef(value: unknown): DatasetRef | undefined {
  let candidate = value;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{')) return undefined;
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  if (
    candidate &&
    typeof candidate === 'object' &&
    (candidate as { kind?: unknown }).kind === 'dataset'
  ) {
    return candidate as DatasetRef;
  }
  return undefined;
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
