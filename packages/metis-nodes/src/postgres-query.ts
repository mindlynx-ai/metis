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
 * The postgres node's visual query-builder (parity with the Helix postgres
 * node): turn an operation + tables/where/orderBy config into a parameterised
 * SQL string, so a workflow's postgres node is portable between the engines.
 *
 * Safety: every user VALUE flows through parameters ($1, $2, ...); every
 * IDENTIFIER (database/schema/table/column/alias) is regex-checked and quoted
 * so an injected quote can never escape; operators and directions are
 * enum-validated. Pure and DB-free, so the generated SQL is unit-testable.
 *
 * Dialects: Metis GENERATES this SQL, so it has to be the target engine's own.
 * A dialect supplies the quote character, the placeholder style and the default
 * schema. Hand-written SQL is never rewritten - that stays the author's dialect.
 */

/** What differs between engines in generated SQL. */
export interface SqlDialect {
  name: string;
  /** " for Postgres, ` for MySQL, [ for SQL Server. */
  quoteChar: string;
  /** The closing quote, when it is not the opening one again: SQL Server is
   *  the odd one out, bracketing an identifier as [name]. */
  quoteEndChar?: string;
  /** $1, $2 ... for Postgres; ? for MySQL; @p1, @p2 ... for SQL Server. */
  placeholder: (index: number) => string;
  /** The schema an unqualified table sits in. MySQL has no layer above the
   *  database, so a qualified name would be wrong there. */
  defaultSchema?: string;
  /** How a row cap is written. Postgres and MySQL take a trailing LIMIT; SQL
   *  Server has no LIMIT at all and caps with a TOP that sits in FRONT of the
   *  columns, so the fragment cannot simply be appended at the end. */
  limitStyle?: 'limit' | 'top';
}

export const POSTGRES_DIALECT: SqlDialect = {
  name: 'postgres',
  quoteChar: '"',
  placeholder: (index) => `$${index}`,
  defaultSchema: 'public',
};

export const MYSQL_DIALECT: SqlDialect = {
  name: 'mysql',
  quoteChar: '`',
  placeholder: () => '?',
};

export const SQLSERVER_DIALECT: SqlDialect = {
  name: 'sqlserver',
  quoteChar: '[',
  quoteEndChar: ']',
  // The mssql driver binds by NAME, and names its positional inputs p1, p2 ...
  // so generated SQL and hand-written SQL for this engine agree on @p1.
  placeholder: (index) => `@p${index}`,
  // Where an unqualified table lands unless the login says otherwise.
  defaultSchema: 'dbo',
  limitStyle: 'top',
};

const DIALECTS: Record<string, SqlDialect> = {
  mysql: MYSQL_DIALECT,
  sqlserver: SQLSERVER_DIALECT,
};

export function dialectFor(engine: string): SqlDialect {
  return DIALECTS[engine] ?? POSTGRES_DIALECT;
}

export interface PgColumn {
  name: string;
  alias?: string;
  value?: unknown;
}
export interface PgTable {
  name: string;
  alias?: string;
  columns?: PgColumn[];
  values?: Record<string, unknown>;
}
export interface PgWhere {
  table?: string;
  column: string;
  operator: string;
  value: unknown;
}
export interface PgOrderBy {
  table?: string;
  column: string;
  direction?: 'ascending' | 'descending';
}
export interface PgBuilderConfig {
  database?: string;
  schema?: string;
  operation?: string;
  tables?: PgTable[];
  join?: unknown[];
  where?: PgWhere[];
  orderBy?: PgOrderBy[];
  limit?: number;
  conflictColumns?: string[];
  updateColumns?: { name: string }[];
}

/**
 * A relation made of an earlier step's rows rather than a table in a schema:
 * the dataset handle a `reference` step produced, wrapped so a later step can
 * filter, order and cap it without materialising the whole thing first.
 */
export interface DerivedSource {
  /** The upstream query, already composed. Becomes a derived table. */
  sql: string;
  /** What the WHERE and ORDER BY clauses address it by. */
  alias: string;
}

export interface BuiltQuery {
  query: string;
  params: unknown[];
}

const IDENT_RE = /^[A-Za-z_]\w*$/;

const ALLOWED_OPERATORS = new Set([
  '=', '!=', '<>', '<', '>', '<=', '>=',
  'LIKE', 'ILIKE', 'NOT LIKE', 'NOT ILIKE', 'IS', 'IS NOT',
]);

function quoteIdent(d: SqlDialect, name: string, label = 'identifier'): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`${d.name}: invalid ${label} "${name}" (must match /^[A-Za-z_]\\w*$/)`);
  }
  return `${d.quoteChar}${name}${d.quoteEndChar ?? d.quoteChar}`;
}

/** `[db.]schema.table`, each part quoted. */
function qualified(d: SqlDialect, config: PgBuilderConfig, table: string): string {
  const db = config.database ? `${quoteIdent(d, config.database, 'database')}.` : '';
  const schemaName = config.schema ?? d.defaultSchema;
  const schema = schemaName ? `${quoteIdent(d, schemaName, 'schema')}.` : '';
  return `${db}${schema}${quoteIdent(d, table, 'table')}`;
}

/** The quoted prefix a where/order clause uses for a table (alias if present). */
function tablePrefix(d: SqlDialect, table: PgTable): string {
  return table.alias ? quoteIdent(d, table.alias, 'alias') : quoteIdent(d, table.name, 'table');
}

/** Build the WHERE fragment, appending its params to `params`. */
function whereClause(d: SqlDialect, clauses: PgWhere[], resolve: (c: PgWhere) => string, params: unknown[], startAt: number): string {
  const parts: string[] = [];
  let i = startAt;
  for (const w of clauses) {
    const op = w.operator.toUpperCase();
    if (!ALLOWED_OPERATORS.has(op)) throw new Error(`${d.name}: operator "${w.operator}" not in allowlist`);
    parts.push(`${resolve(w)} ${op} ${d.placeholder(i++)}`);
    params.push(w.value);
  }
  return parts.join(' AND ');
}

/** The SELECT column list across all tables (empty => `*`). */
function selectColumns(d: SqlDialect, tables: PgTable[]): string {
  const cols: string[] = [];
  for (const table of tables) {
    for (const col of table.columns ?? []) {
      const base = `${tablePrefix(d, table)}.${quoteIdent(d, col.name, 'column')}`;
      cols.push(col.alias ? `${base} AS ${quoteIdent(d, col.alias, 'alias')}` : base);
    }
  }
  return cols.length > 0 ? cols.join(', ') : '*';
}

/** The ORDER BY fragment, resolving each clause's table by name. */
function orderByClause(d: SqlDialect, orderBy: PgOrderBy[], tables: PgTable[], first: PgTable): string {
  return orderBy
    .map((o) => {
      const t = tables.find((e) => e.name === o.table) ?? first;
      const dir = o.direction === 'descending' ? 'DESC' : 'ASC';
      return `${tablePrefix(d, t)}.${quoteIdent(d, o.column, 'column')} ${dir}`;
    })
    .join(', ');
}

/**
 * What the SELECT reads from. A derived source stands in for the table: the
 * rows are whatever an earlier step's query produced, so there is exactly one
 * relation, it is named by its alias rather than looked up in a schema, and
 * the columns still come from the config so "just these, filtered" narrows.
 */
function selectSource(
  d: SqlDialect,
  config: PgBuilderConfig,
  from: DerivedSource | undefined,
): { tables: PgTable[]; columnSource: PgTable[]; target: string; trailingAlias: string } {
  if (from) {
    const tables = [{ name: from.alias }];
    return {
      tables,
      columnSource: [{ name: from.alias, columns: (config.tables ?? [])[0]?.columns }],
      target: `(${from.sql}) AS ${quoteIdent(d, from.alias, 'alias')}`,
      trailingAlias: '',
    };
  }
  const tables = config.tables ?? [];
  if (tables.length === 0) throw new Error(`${d.name}: select needs at least one table`);
  const first = tables[0]!;
  return {
    tables,
    columnSource: tables,
    target: qualified(d, config, first.name),
    trailingAlias: first.alias ? ` ${quoteIdent(d, first.alias, 'alias')}` : '',
  };
}

function buildSelect(d: SqlDialect, config: PgBuilderConfig, from?: DerivedSource): BuiltQuery {
  if (config.join && config.join.length > 0) throw new Error(`${d.name}: JOIN is not yet supported`);
  const { tables, columnSource, target, trailingAlias } = selectSource(d, config, from);

  const first = tables[0]!;
  const isDistinct = (config.operation ?? '').toLowerCase() === 'select distinct';
  const cap = typeof config.limit === 'number' && config.limit > 0 ? Math.floor(config.limit) : undefined;
  // A SQL Server cap has to be decided before the column list is written, not
  // appended after it, so it is resolved here rather than at the end.
  const top = cap !== undefined && d.limitStyle === 'top' ? `TOP (${cap}) ` : '';
  let query = `SELECT ${isDistinct ? 'DISTINCT ' : ''}${top}${selectColumns(d, columnSource)} FROM ${target}${trailingAlias}`;

  const params: unknown[] = [];
  if (config.where && config.where.length > 0) {
    const resolve = (w: PgWhere) => {
      const t = tables.find((e) => e.name === w.table) ?? first;
      return `${tablePrefix(d, t)}.${quoteIdent(d, w.column, 'column')}`;
    };
    query += ` WHERE ${whereClause(d, config.where, resolve, params, 1)}`;
  }
  if (config.orderBy && config.orderBy.length > 0) {
    query += ` ORDER BY ${orderByClause(d, config.orderBy, tables, first)}`;
  }
  if (cap !== undefined && d.limitStyle !== 'top') {
    query += ` LIMIT ${cap}`;
  }
  return { query, params };
}

function buildInsert(config: PgBuilderConfig): BuiltQuery {
  const table = (config.tables ?? [])[0];
  if (!table) throw new Error('postgres: insert needs a table');
  const cols: string[] = [];
  const placeholders: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const [name, value] of Object.entries(table.values ?? {})) {
    cols.push(quoteIdent(POSTGRES_DIALECT, name, 'column'));
    placeholders.push(`$${i++}`);
    params.push(value);
  }
  if (cols.length === 0) throw new Error('postgres: insert has no columns with values');
  const query = `INSERT INTO ${qualified(POSTGRES_DIALECT, config, table.name)} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
  return { query, params };
}

function buildUpdate(config: PgBuilderConfig): BuiltQuery {
  const table = (config.tables ?? [])[0];
  if (!table) throw new Error('postgres: update needs a table');
  if (!config.where || config.where.length === 0) {
    throw new Error('postgres: update requires a WHERE clause (refusing unbounded update)');
  }
  const params: unknown[] = [];
  const setParts: string[] = [];
  let i = 1;
  for (const [name, value] of Object.entries(table.values ?? {})) {
    setParts.push(`${quoteIdent(POSTGRES_DIALECT, name, 'column')} = $${i++}`);
    params.push(value);
  }
  if (setParts.length === 0) throw new Error('postgres: update has no columns to set');
  const where = whereClause(POSTGRES_DIALECT, config.where, (w) => quoteIdent(POSTGRES_DIALECT, w.column, 'column'), params, i);
  const query = `UPDATE ${qualified(POSTGRES_DIALECT, config, table.name)} SET ${setParts.join(', ')} WHERE ${where} RETURNING *`;
  return { query, params };
}

function buildDelete(config: PgBuilderConfig): BuiltQuery {
  const table = (config.tables ?? [])[0];
  if (!table) throw new Error('postgres: delete needs a table');
  if (!config.where || config.where.length === 0) {
    throw new Error('postgres: delete requires a WHERE clause (refusing unbounded delete)');
  }
  const params: unknown[] = [];
  const where = whereClause(POSTGRES_DIALECT, config.where, (w) => quoteIdent(POSTGRES_DIALECT, w.column, 'column'), params, 1);
  const query = `DELETE FROM ${qualified(POSTGRES_DIALECT, config, table.name)} WHERE ${where} RETURNING *`;
  return { query, params };
}

function buildUpsert(config: PgBuilderConfig): BuiltQuery {
  const table = (config.tables ?? [])[0];
  if (!table) throw new Error('postgres: upsert needs a table');
  if (!config.conflictColumns || config.conflictColumns.length === 0) {
    throw new Error('postgres: upsert requires conflictColumns');
  }
  const cols: string[] = [];
  const placeholders: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const col of table.columns ?? []) {
    if (col.value === undefined) continue;
    cols.push(quoteIdent(POSTGRES_DIALECT, col.name, 'column'));
    placeholders.push(`$${i++}`);
    params.push(col.value);
  }
  if (cols.length === 0) throw new Error('postgres: upsert has no columns with values');
  const conflicts = config.conflictColumns;
  const conflictCols = conflicts.map((c) => quoteIdent(POSTGRES_DIALECT, c, 'column'));
  const updateNames =
    config.updateColumns && config.updateColumns.length > 0
      ? config.updateColumns.map((c) => c.name)
      : (table.columns ?? []).map((c) => c.name).filter((n) => !conflicts.includes(n));
  const updates = updateNames.map(
    (n) => `${quoteIdent(POSTGRES_DIALECT, n, 'column')} = EXCLUDED.${quoteIdent(POSTGRES_DIALECT, n, 'column')}`,
  );
  const query = `INSERT INTO ${qualified(POSTGRES_DIALECT, config, table.name)} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (${conflictCols.join(', ')}) DO UPDATE SET ${updates.join(', ')} RETURNING *`;
  return { query, params };
}

/**
 * Build a parameterised query from the visual builder config, by operation.
 *
 * Reads are generated for whichever engine the connection uses. Writes are
 * Postgres-only for now and say so: INSERT/UPDATE/DELETE lean on `RETURNING *`
 * and upsert on `ON CONFLICT`, neither of which has a portable equivalent (SQL
 * Server spells them OUTPUT INSERTED.* and MERGE, MySQL neither), and emitting
 * Postgres syntax at another engine would fail with a confusing parser error
 * instead of an answerable one. Raw SQL reaches every engine meanwhile.
 */
export function buildQuery(
  config: PgBuilderConfig,
  dialect: SqlDialect = POSTGRES_DIALECT,
  from?: DerivedSource,
): BuiltQuery {
  const op = (config.operation ?? 'select').toLowerCase();
  const isRead = op === 'select' || op === 'select distinct';
  // Writing through a handle would mean writing to whatever an earlier query
  // happened to select, which is not a table anyone named.
  if (from && !isRead) throw new Error(`${dialect.name}: a dataset reference can only be read from`);
  if (!isRead && dialect.name !== 'postgres') {
    throw new Error(
      `${dialect.name}: the visual builder can only read on this engine; write it as SQL in the query box`,
    );
  }
  switch (op) {
    case 'select':
    case 'select distinct':
      return buildSelect(dialect, config, from);
    case 'insert':
      return buildInsert(config);
    case 'update':
      return buildUpdate(config);
    case 'delete':
      return buildDelete(config);
    case 'upsert':
      return buildUpsert(config);
    default:
      throw new Error(`${dialect.name}: unsupported operation "${String(config.operation)}"`);
  }
}
