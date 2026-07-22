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
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// node:sqlite is a prefix-only builtin that some bundlers cannot yet
// resolve as a static import, so it is loaded through createRequire.
const requireBuiltin = createRequire(import.meta.url);
const { DatabaseSync } = requireBuiltin('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};
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
 * The SQLite adapter: the default store shipped
 * in the box, using the Node built-in sqlite driver so the open build
 * carries no native dependency. Each registered definition becomes one
 * physical table: real indexed columns for the key and secondary-index
 * attributes, the full record in a JSON column, and key-based cursors
 * encoded from the sort key so paging semantics match the reference
 * adapter exactly.
 */
export class SqliteAdapter implements DataStore {
  private readonly db: DatabaseSyncType;
  private readonly tables = new Map<string, TableDefinition>();

  constructor(filePath: string) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
  }

  close(): void {
    this.db.close();
  }

  private definitionOf(table: string): TableDefinition {
    const definition = this.tables.get(table);
    if (!definition) throw new Error(`table "${table}" is not registered`);
    return definition;
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
    const columns = this.promotedAttributes(definition)
      .map((name) => `${quote(name)} TEXT`)
      .join(', ');
    const pk = definition.sortAttribute
      ? `PRIMARY KEY (${quote(definition.partitionAttribute)}, ${quote(definition.sortAttribute)})`
      : `PRIMARY KEY (${quote(definition.partitionAttribute)})`;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${quote(definition.name)} (${columns}, "item" TEXT NOT NULL, ${pk})`,
    );
    for (const index of definition.indexes ?? []) {
      const indexColumns = index.sortAttribute
        ? `${quote(index.partitionAttribute)}, ${quote(index.sortAttribute)}`
        : quote(index.partitionAttribute);
      const indexName = quote(`ix_${definition.name}_${index.name}`);
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS ${indexName} ON ${quote(definition.name)} (${indexColumns})`,
      );
    }
  }

  private keyWhere(definition: TableDefinition): string {
    return definition.sortAttribute
      ? `${quote(definition.partitionAttribute)} = ? AND ${quote(definition.sortAttribute)} = ?`
      : `${quote(definition.partitionAttribute)} = ?`;
  }

  private keyValues(definition: TableDefinition, key: ItemKey): string[] {
    return definition.sortAttribute
      ? [key.partitionKey, key.sortKey ?? '']
      : [key.partitionKey];
  }

  async get(table: string, key: ItemKey): Promise<ItemRecord | undefined> {
    const definition = this.definitionOf(table);
    const row = this.db
      .prepare(`SELECT "item" FROM ${quote(table)} WHERE ${this.keyWhere(definition)}`)
      .get(...this.keyValues(definition, key)) as { item?: string } | undefined;
    return row?.item !== undefined ? (JSON.parse(row.item) as ItemRecord) : undefined;
  }

  async put(table: string, item: ItemRecord, options?: PutOptions): Promise<void> {
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
    const placeholders = [...promoted.map(() => '?'), '?'].join(', ');
    const parameters = [...values, JSON.stringify(item)];

    if (options?.condition === 'must-not-exist') {
      try {
        this.db
          .prepare(`INSERT INTO ${quote(table)} (${columnSql}) VALUES (${placeholders})`)
          .run(...parameters);
      } catch (error) {
        if (String(error).includes('UNIQUE')) {
          throw new ConditionFailedError('item already exists');
        }
        throw error;
      }
      return;
    }
    if (options?.condition === 'must-exist') {
      const key: ItemKey = {
        partitionKey: String(item[definition.partitionAttribute]),
        sortKey: definition.sortAttribute ? String(item[definition.sortAttribute] ?? '') : undefined,
      };
      const existing = await this.get(table, key);
      if (!existing) throw new ConditionFailedError('item does not exist');
    }
    this.db
      .prepare(`INSERT OR REPLACE INTO ${quote(table)} (${columnSql}) VALUES (${placeholders})`)
      .run(...parameters);
  }

  async patch(table: string, key: ItemKey, changes: ItemRecord): Promise<void> {
    const existing = await this.get(table, key);
    if (!existing) throw new ConditionFailedError('item does not exist');
    await this.put(table, { ...existing, ...changes });
  }

  async deleteItem(table: string, key: ItemKey): Promise<void> {
    const definition = this.definitionOf(table);
    this.db
      .prepare(`DELETE FROM ${quote(table)} WHERE ${this.keyWhere(definition)}`)
      .run(...this.keyValues(definition, key));
  }

  private buildQueryFilters(
    request: QueryRequest,
    sortExpr: string,
    baseExpr: string,
    partitionColumn: string,
  ): { where: string[]; parameters: (string | number)[] } {
    const where: string[] = [`${partitionColumn} = ?`];
    const parameters: (string | number)[] = [request.partitionValue];
    if (request.sortPrefix !== undefined) {
      where.push(`substr(${sortExpr}, 1, ?) = ?`);
      parameters.push(request.sortPrefix.length, request.sortPrefix);
    }
    if (request.sortRange?.from !== undefined) {
      where.push(`${sortExpr} >= ?`);
      parameters.push(request.sortRange.from);
    }
    if (request.sortRange?.to !== undefined) {
      where.push(`${sortExpr} <= ?`);
      parameters.push(request.sortRange.to);
    }
    if (request.cursor) {
      const state = decodeCursor(request.cursor);
      const comparator = request.ascending !== false ? '>' : '<';
      where.push(
        `(${sortExpr} ${comparator} ? OR (${sortExpr} = ? AND ${baseExpr} ${comparator} ?))`,
      );
      parameters.push(state.sort, state.sort, state.base);
    }
    return { where, parameters };
  }

  async query(request: QueryRequest): Promise<QueryPage> {
    const definition = this.definitionOf(request.table);
    const index = request.index
      ? definition.indexes?.find((candidate) => candidate.name === request.index)
      : undefined;
    if (request.index && !index) {
      throw new Error(`index "${request.index}" is not defined on table "${request.table}"`);
    }
    const partitionColumn = quote(index?.partitionAttribute ?? definition.partitionAttribute);
    const sortAttribute = index?.sortAttribute ?? definition.sortAttribute;
    const sortColumn = sortAttribute ? quote(sortAttribute) : undefined;
    const sortExpr = sortColumn ? `COALESCE(${sortColumn}, '')` : `''`;
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
    const rows = this.db
      .prepare(
        `SELECT "item", ${sortExpr} AS sort_value, ${baseExpr} AS base_value FROM ${quote(request.table)} ` +
          `WHERE ${where.join(' AND ')} ` +
          `ORDER BY sort_value ${direction}, base_value ${direction} ${limitSql}`,
      )
      .all(...parameters) as { item: string; sort_value: string; base_value: string }[];

    const more = request.limit !== undefined && rows.length > request.limit;
    const page = more ? rows.slice(0, request.limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((row) => JSON.parse(row.item) as ItemRecord),
      cursor: more && last ? encodeCursor({ sort: last.sort_value, base: last.base_value }) : undefined,
    };
  }
}
