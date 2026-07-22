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
import pg from 'pg';
import {
  ConditionFailedError,
  type DataStore,
  type ItemKey,
  type ItemRecord,
  type PutOptions,
  type QueryPage,
  type QueryRequest,
  type TableDefinition,
} from '@mindlynx/metis-ports';

interface CursorState {
  sort: string;
  base: string;
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): CursorState {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorState;
}

const IDENTIFIER = /^[A-Za-z_]\w*$/;

function quote(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`invalid identifier "${name}"`);
  return `"${name}"`;
}

/**
 * The Postgres adapter: the same
 * definition-driven mapping as SQLite with JSONB for the record and
 * COLLATE "C" comparisons so ordering and cursors are byte-identical
 * to the reference adapter. Selected by a single environment variable
 * (see env.ts) with no other change.
 */
export class PostgresAdapter implements DataStore {
  private readonly pool: pg.Pool;
  private readonly schema: string;
  private readonly tables = new Map<string, TableDefinition>();
  private pendingDdl: Promise<void> = Promise.resolve();

  constructor(connectionString: string, options?: { schema?: string }) {
    this.pool = new pg.Pool({ connectionString });
    this.schema = options?.schema ?? 'public';
    if (!IDENTIFIER.test(this.schema)) throw new Error(`invalid schema "${this.schema}"`);
  }

  /** Await all pending DDL; useful right after registering tables. */
  async ready(): Promise<void> {
    await this.pendingDdl;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async dropSchema(): Promise<void> {
    if (this.schema === 'public') throw new Error('refusing to drop the public schema');
    await this.pendingDdl;
    await this.pool.query(`DROP SCHEMA IF EXISTS ${quote(this.schema)} CASCADE`);
  }

  private definitionOf(table: string): TableDefinition {
    const definition = this.tables.get(table);
    if (!definition) throw new Error(`table "${table}" is not registered`);
    return definition;
  }

  private tableRef(name: string): string {
    return `${quote(this.schema)}.${quote(name)}`;
  }

  private promotedAttributes(definition: TableDefinition): string[] {
    const names = new Set<string>([definition.partitionAttribute]);
    if (definition.sortAttribute) names.add(definition.sortAttribute);
    for (const index of definition.indexes ?? []) {
      names.add(index.partitionAttribute);
      if (index.sortAttribute) names.add(index.sortAttribute);
    }
    return [...names];
  }

  registerTable(definition: TableDefinition): void {
    this.tables.set(definition.name, definition);
    this.pendingDdl = this.pendingDdl.then(() => this.createTable(definition));
  }

  private async createTable(definition: TableDefinition): Promise<void> {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${quote(this.schema)}`);
    const columns = this.promotedAttributes(definition)
      .map((name) => `${quote(name)} TEXT`)
      .join(', ');
    const pk = definition.sortAttribute
      ? `PRIMARY KEY (${quote(definition.partitionAttribute)}, ${quote(definition.sortAttribute)})`
      : `PRIMARY KEY (${quote(definition.partitionAttribute)})`;
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.tableRef(definition.name)} ` +
        `(${columns}, "item" JSONB NOT NULL, ${pk})`,
    );
    for (const index of definition.indexes ?? []) {
      const indexColumns = index.sortAttribute
        ? `${quote(index.partitionAttribute)}, ${quote(index.sortAttribute)}`
        : quote(index.partitionAttribute);
      const indexName = quote(`ix_${definition.name}_${index.name}`);
      await this.pool.query(
        `CREATE INDEX IF NOT EXISTS ${indexName} ON ${this.tableRef(definition.name)} (${indexColumns})`,
      );
    }
  }

  private keyWhere(definition: TableDefinition): string {
    return definition.sortAttribute
      ? `${quote(definition.partitionAttribute)} = $1 AND ${quote(definition.sortAttribute)} = $2`
      : `${quote(definition.partitionAttribute)} = $1`;
  }

  private keyValues(definition: TableDefinition, key: ItemKey): string[] {
    return definition.sortAttribute ? [key.partitionKey, key.sortKey ?? ''] : [key.partitionKey];
  }

  private static itemOf(row: { item: unknown }): ItemRecord {
    return (typeof row.item === 'string' ? JSON.parse(row.item) : row.item) as ItemRecord;
  }

  async get(table: string, key: ItemKey): Promise<ItemRecord | undefined> {
    await this.pendingDdl;
    const definition = this.definitionOf(table);
    const result = await this.pool.query(
      `SELECT "item" FROM ${this.tableRef(table)} WHERE ${this.keyWhere(definition)}`,
      this.keyValues(definition, key),
    );
    const row = result.rows[0] as { item: unknown } | undefined;
    return row ? PostgresAdapter.itemOf(row) : undefined;
  }

  async put(table: string, item: ItemRecord, options?: PutOptions): Promise<void> {
    await this.pendingDdl;
    const definition = this.definitionOf(table);
    if (item[definition.partitionAttribute] === undefined) {
      throw new Error(`item is missing partition attribute "${definition.partitionAttribute}"`);
    }
    const promoted = this.promotedAttributes(definition);
    const values = promoted.map((name) => {
      const value = item[name];
      if (name === definition.sortAttribute) return String(value ?? '');
      return value === undefined ? null : String(value);
    });
    const columnSql = [...promoted.map(quote), '"item"'].join(', ');
    const placeholders = [...promoted, 'item'].map((_, i) => `$${i + 1}`).join(', ');
    const parameters = [...values, JSON.stringify(item)];
    const conflictKey = definition.sortAttribute
      ? `(${quote(definition.partitionAttribute)}, ${quote(definition.sortAttribute)})`
      : `(${quote(definition.partitionAttribute)})`;

    if (options?.condition === 'must-not-exist') {
      const result = await this.pool.query(
        `INSERT INTO ${this.tableRef(table)} (${columnSql}) VALUES (${placeholders}) ` +
          `ON CONFLICT ${conflictKey} DO NOTHING`,
        parameters,
      );
      if (result.rowCount === 0) throw new ConditionFailedError('item already exists');
      return;
    }
    if (options?.condition === 'must-exist') {
      const key: ItemKey = {
        partitionKey: String(item[definition.partitionAttribute]),
        sortKey: definition.sortAttribute
          ? String(item[definition.sortAttribute] ?? '')
          : undefined,
      };
      const existing = await this.get(table, key);
      if (!existing) throw new ConditionFailedError('item does not exist');
    }
    const updates = [...promoted.map((name) => `${quote(name)} = EXCLUDED.${quote(name)}`), '"item" = EXCLUDED."item"'];
    await this.pool.query(
      `INSERT INTO ${this.tableRef(table)} (${columnSql}) VALUES (${placeholders}) ` +
        `ON CONFLICT ${conflictKey} DO UPDATE SET ${updates.join(', ')}`,
      parameters,
    );
  }

  async patch(table: string, key: ItemKey, changes: ItemRecord): Promise<void> {
    const existing = await this.get(table, key);
    if (!existing) throw new ConditionFailedError('item does not exist');
    await this.put(table, { ...existing, ...changes });
  }

  async deleteItem(table: string, key: ItemKey): Promise<void> {
    await this.pendingDdl;
    const definition = this.definitionOf(table);
    await this.pool.query(
      `DELETE FROM ${this.tableRef(table)} WHERE ${this.keyWhere(definition)}`,
      this.keyValues(definition, key),
    );
  }

  private buildQueryFilters(
    request: QueryRequest,
    sortExpr: string,
    baseExpr: string,
    partitionColumn: string,
  ): { where: string[]; parameters: (string | number)[] } {
    const where: string[] = [`${partitionColumn} = $1`];
    const parameters: (string | number)[] = [request.partitionValue];
    const next = () => `$${parameters.length + 1}`;
    if (request.sortPrefix !== undefined) {
      const lengthParam = next();
      parameters.push(request.sortPrefix.length);
      const prefixParam = next();
      parameters.push(request.sortPrefix);
      where.push(`substr(${sortExpr}, 1, ${lengthParam}::int) = ${prefixParam}`);
    }
    if (request.sortRange?.from !== undefined) {
      const param = next();
      parameters.push(request.sortRange.from);
      where.push(`${sortExpr} >= ${param} COLLATE "C"`);
    }
    if (request.sortRange?.to !== undefined) {
      const param = next();
      parameters.push(request.sortRange.to);
      where.push(`${sortExpr} <= ${param} COLLATE "C"`);
    }
    if (request.cursor) {
      const state = decodeCursor(request.cursor);
      const comparator = request.ascending !== false ? '>' : '<';
      const sortParam = next();
      parameters.push(state.sort);
      const sortEqParam = next();
      parameters.push(state.sort);
      const baseParam = next();
      parameters.push(state.base);
      where.push(
        `(${sortExpr} ${comparator} ${sortParam} COLLATE "C" OR ` +
          `(${sortExpr} = ${sortEqParam} AND ${baseExpr} ${comparator} ${baseParam} COLLATE "C"))`,
      );
    }
    return { where, parameters };
  }

  async query(request: QueryRequest): Promise<QueryPage> {
    await this.pendingDdl;
    const definition = this.definitionOf(request.table);
    const index = request.index
      ? definition.indexes?.find((candidate) => candidate.name === request.index)
      : undefined;
    if (request.index && !index) {
      throw new Error(`index "${request.index}" is not defined on table "${request.table}"`);
    }
    const partitionColumn = quote(index?.partitionAttribute ?? definition.partitionAttribute);
    const sortAttribute = index?.sortAttribute ?? definition.sortAttribute;
    const sortExpr = sortAttribute ? `COALESCE(${quote(sortAttribute)}, '')` : `''`;
    const baseExpr = definition.sortAttribute
      ? `(${quote(definition.partitionAttribute)} || ' ' || COALESCE(${quote(definition.sortAttribute)}, ''))`
      : `(${quote(definition.partitionAttribute)} || ' ')`;

    const ascending = request.ascending !== false;
    const { where, parameters } = this.buildQueryFilters(
      request,
      sortExpr,
      baseExpr,
      partitionColumn,
    );
    const direction = ascending ? 'ASC' : 'DESC';
    const limitSql = request.limit !== undefined ? `LIMIT ${Number(request.limit) + 1}` : '';
    const result = await this.pool.query(
      `SELECT "item", ${sortExpr} AS sort_value, ${baseExpr} AS base_value ` +
        `FROM ${this.tableRef(request.table)} WHERE ${where.join(' AND ')} ` +
        `ORDER BY ${sortExpr} COLLATE "C" ${direction}, ${baseExpr} COLLATE "C" ${direction} ${limitSql}`,
      parameters,
    );
    const rows = result.rows as { item: unknown; sort_value: string; base_value: string }[];
    const more = request.limit !== undefined && rows.length > request.limit;
    const page = more ? rows.slice(0, request.limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((row) => PostgresAdapter.itemOf(row)),
      cursor:
        more && last ? encodeCursor({ sort: last.sort_value, base: last.base_value }) : undefined,
    };
  }
}
