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
 * IDENTIFIER (database/schema/table/column/alias) is regex-checked and double-
 * quoted so an injected quote can never escape; operators and directions are
 * enum-validated. Pure and DB-free, so the generated SQL is unit-testable.
 */

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

export interface BuiltQuery {
  query: string;
  params: unknown[];
}

const IDENT_RE = /^[A-Za-z_]\w*$/;

const ALLOWED_OPERATORS = new Set([
  '=', '!=', '<>', '<', '>', '<=', '>=',
  'LIKE', 'ILIKE', 'NOT LIKE', 'NOT ILIKE', 'IS', 'IS NOT',
]);

function quoteIdent(name: string, label = 'identifier'): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`postgres: invalid ${label} "${name}" (must match /^[A-Za-z_]\\w*$/)`);
  }
  return `"${name}"`;
}

/** `[db.]schema.table`, each part quoted. */
function qualified(config: PgBuilderConfig, table: string): string {
  const db = config.database ? `${quoteIdent(config.database, 'database')}.` : '';
  const schema = quoteIdent(config.schema ?? 'public', 'schema');
  return `${db}${schema}.${quoteIdent(table, 'table')}`;
}

/** The quoted prefix a where/order clause uses for a table (alias if present). */
function tablePrefix(table: PgTable): string {
  return table.alias ? quoteIdent(table.alias, 'alias') : quoteIdent(table.name, 'table');
}

/** Build the WHERE fragment, appending its params to `params`. */
function whereClause(clauses: PgWhere[], resolve: (c: PgWhere) => string, params: unknown[], startAt: number): string {
  const parts: string[] = [];
  let i = startAt;
  for (const w of clauses) {
    const op = w.operator.toUpperCase();
    if (!ALLOWED_OPERATORS.has(op)) throw new Error(`postgres: operator "${w.operator}" not in allowlist`);
    parts.push(`${resolve(w)} ${op} $${i++}`);
    params.push(w.value);
  }
  return parts.join(' AND ');
}

/** The SELECT column list across all tables (empty => `*`). */
function selectColumns(tables: PgTable[]): string {
  const cols: string[] = [];
  for (const table of tables) {
    for (const col of table.columns ?? []) {
      const base = `${tablePrefix(table)}.${quoteIdent(col.name, 'column')}`;
      cols.push(col.alias ? `${base} AS ${quoteIdent(col.alias, 'alias')}` : base);
    }
  }
  return cols.length > 0 ? cols.join(', ') : '*';
}

/** The ORDER BY fragment, resolving each clause's table by name. */
function orderByClause(orderBy: PgOrderBy[], tables: PgTable[], first: PgTable): string {
  return orderBy
    .map((o) => {
      const t = tables.find((e) => e.name === o.table) ?? first;
      const dir = o.direction === 'descending' ? 'DESC' : 'ASC';
      return `${tablePrefix(t)}.${quoteIdent(o.column, 'column')} ${dir}`;
    })
    .join(', ');
}

function buildSelect(config: PgBuilderConfig): BuiltQuery {
  const tables = config.tables ?? [];
  if (tables.length === 0) throw new Error('postgres: select needs at least one table');
  if (config.join && config.join.length > 0) throw new Error('postgres: JOIN is not yet supported');

  const first = tables[0]!;
  const isDistinct = (config.operation ?? '').toLowerCase() === 'select distinct';
  let query = `SELECT ${isDistinct ? 'DISTINCT ' : ''}${selectColumns(tables)} FROM ${qualified(config, first.name)}`;
  if (first.alias) query += ` ${quoteIdent(first.alias, 'alias')}`;

  const params: unknown[] = [];
  if (config.where && config.where.length > 0) {
    const resolve = (w: PgWhere) => {
      const t = tables.find((e) => e.name === w.table) ?? first;
      return `${tablePrefix(t)}.${quoteIdent(w.column, 'column')}`;
    };
    query += ` WHERE ${whereClause(config.where, resolve, params, 1)}`;
  }
  if (config.orderBy && config.orderBy.length > 0) {
    query += ` ORDER BY ${orderByClause(config.orderBy, tables, first)}`;
  }
  if (typeof config.limit === 'number' && config.limit > 0) {
    query += ` LIMIT ${Math.floor(config.limit)}`;
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
    cols.push(quoteIdent(name, 'column'));
    placeholders.push(`$${i++}`);
    params.push(value);
  }
  if (cols.length === 0) throw new Error('postgres: insert has no columns with values');
  const query = `INSERT INTO ${qualified(config, table.name)} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
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
    setParts.push(`${quoteIdent(name, 'column')} = $${i++}`);
    params.push(value);
  }
  if (setParts.length === 0) throw new Error('postgres: update has no columns to set');
  const where = whereClause(config.where, (w) => quoteIdent(w.column, 'column'), params, i);
  const query = `UPDATE ${qualified(config, table.name)} SET ${setParts.join(', ')} WHERE ${where} RETURNING *`;
  return { query, params };
}

function buildDelete(config: PgBuilderConfig): BuiltQuery {
  const table = (config.tables ?? [])[0];
  if (!table) throw new Error('postgres: delete needs a table');
  if (!config.where || config.where.length === 0) {
    throw new Error('postgres: delete requires a WHERE clause (refusing unbounded delete)');
  }
  const params: unknown[] = [];
  const where = whereClause(config.where, (w) => quoteIdent(w.column, 'column'), params, 1);
  const query = `DELETE FROM ${qualified(config, table.name)} WHERE ${where} RETURNING *`;
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
    cols.push(quoteIdent(col.name, 'column'));
    placeholders.push(`$${i++}`);
    params.push(col.value);
  }
  if (cols.length === 0) throw new Error('postgres: upsert has no columns with values');
  const conflicts = config.conflictColumns;
  const conflictCols = conflicts.map((c) => quoteIdent(c, 'column'));
  const updateNames =
    config.updateColumns && config.updateColumns.length > 0
      ? config.updateColumns.map((c) => c.name)
      : (table.columns ?? []).map((c) => c.name).filter((n) => !conflicts.includes(n));
  const updates = updateNames.map(
    (n) => `${quoteIdent(n, 'column')} = EXCLUDED.${quoteIdent(n, 'column')}`,
  );
  const query = `INSERT INTO ${qualified(config, table.name)} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (${conflictCols.join(', ')}) DO UPDATE SET ${updates.join(', ')} RETURNING *`;
  return { query, params };
}

/** Build a parameterised query from the visual builder config, by operation. */
export function buildQuery(config: PgBuilderConfig): BuiltQuery {
  const op = (config.operation ?? 'select').toLowerCase();
  switch (op) {
    case 'select':
    case 'select distinct':
      return buildSelect(config);
    case 'insert':
      return buildInsert(config);
    case 'update':
      return buildUpdate(config);
    case 'delete':
      return buildDelete(config);
    case 'upsert':
      return buildUpsert(config);
    default:
      throw new Error(`postgres: unsupported operation "${String(config.operation)}"`);
  }
}
