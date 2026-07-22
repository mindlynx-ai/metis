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

function codeUnitCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The in-memory reference adapter: the executable authority for
 * DataStore semantics. Cursors are key-based, never
 * offset-based, so pagination stays stable under interleaved writes,
 * matching the DynamoDB adapter semantics the SQL adapters mirror.
 */
export class MemoryAdapter implements DataStore {
  private readonly tables = new Map<string, TableDefinition>();
  private readonly rows = new Map<string, Map<string, ItemRecord>>();

  registerTable(definition: TableDefinition): void {
    this.tables.set(definition.name, definition);
    if (!this.rows.has(definition.name)) this.rows.set(definition.name, new Map());
  }

  private definitionOf(table: string): TableDefinition {
    const definition = this.tables.get(table);
    if (!definition) throw new Error(`table "${table}" is not registered`);
    return definition;
  }

  private baseKeyOf(definition: TableDefinition, item: ItemRecord): string {
    const partition = String(item[definition.partitionAttribute]);
    const sort = definition.sortAttribute ? String(item[definition.sortAttribute] ?? '') : '';
    return `${partition} ${sort}`;
  }

  async get(table: string, key: ItemKey): Promise<ItemRecord | undefined> {
    this.definitionOf(table);
    const item = this.rows.get(table)?.get(`${key.partitionKey} ${key.sortKey ?? ''}`);
    return item ? structuredClone(item) : undefined;
  }

  async put(table: string, item: ItemRecord, options?: PutOptions): Promise<void> {
    const definition = this.definitionOf(table);
    if (item[definition.partitionAttribute] === undefined) {
      throw new Error(`item is missing partition attribute "${definition.partitionAttribute}"`);
    }
    const bucket = this.rows.get(table);
    if (!bucket) throw new Error(`table "${table}" is not registered`);
    const key = this.baseKeyOf(definition, item);
    const exists = bucket.has(key);
    if (options?.condition === 'must-not-exist' && exists) {
      throw new ConditionFailedError('item already exists');
    }
    if (options?.condition === 'must-exist' && !exists) {
      throw new ConditionFailedError('item does not exist');
    }
    bucket.set(key, structuredClone(item));
  }

  async patch(table: string, key: ItemKey, changes: ItemRecord): Promise<void> {
    this.definitionOf(table);
    const composite = `${key.partitionKey} ${key.sortKey ?? ''}`;
    const existing = this.rows.get(table)?.get(composite);
    if (!existing) throw new ConditionFailedError('item does not exist');
    this.rows.get(table)?.set(composite, { ...existing, ...structuredClone(changes) });
  }

  async deleteItem(table: string, key: ItemKey): Promise<void> {
    this.definitionOf(table);
    this.rows.get(table)?.delete(`${key.partitionKey} ${key.sortKey ?? ''}`);
  }

  async query(request: QueryRequest): Promise<QueryPage> {
    const definition = this.definitionOf(request.table);
    const index = request.index
      ? definition.indexes?.find((candidate) => candidate.name === request.index)
      : undefined;
    if (request.index && !index) {
      throw new Error(`index "${request.index}" is not defined on table "${request.table}"`);
    }
    const partitionAttribute = index?.partitionAttribute ?? definition.partitionAttribute;
    const sortAttribute = index?.sortAttribute ?? definition.sortAttribute;

    let matches = [...(this.rows.get(request.table)?.values() ?? [])].filter((item) => {
      if (index && item[partitionAttribute] === undefined) return false;
      return String(item[partitionAttribute]) === request.partitionValue;
    });

    const sortValueOf = (item: ItemRecord): string =>
      sortAttribute ? String(item[sortAttribute] ?? '') : '';

    if (request.sortPrefix !== undefined) {
      matches = matches.filter((item) => sortValueOf(item).startsWith(request.sortPrefix ?? ''));
    }
    if (request.sortRange) {
      const { from, to } = request.sortRange;
      matches = matches.filter((item) => {
        const value = sortValueOf(item);
        if (from !== undefined && value < from) return false;
        if (to !== undefined && value > to) return false;
        return true;
      });
    }

    const ascending = request.ascending !== false;
    matches.sort((a, b) => {
      const bySort = codeUnitCompare(sortValueOf(a), sortValueOf(b));
      const ordered =
        bySort !== 0
          ? bySort
          : codeUnitCompare(this.baseKeyOf(definition, a), this.baseKeyOf(definition, b));
      return ascending ? ordered : -ordered;
    });

    if (request.cursor) {
      const state = decodeCursor(request.cursor);
      matches = matches.filter((item) => {
        const bySort = codeUnitCompare(sortValueOf(item), state.sort);
        const byBase = codeUnitCompare(this.baseKeyOf(definition, item), state.base);
        const comparison = bySort !== 0 ? bySort : byBase;
        return ascending ? comparison > 0 : comparison < 0;
      });
    }

    const limit = request.limit ?? matches.length;
    const items = matches.slice(0, limit);
    const more = matches.length > items.length;
    const last = items[items.length - 1];
    return {
      items: items.map((item) => structuredClone(item)),
      cursor:
        more && last
          ? encodeCursor({ sort: sortValueOf(last), base: this.baseKeyOf(definition, last) })
          : undefined,
    };
  }
}
