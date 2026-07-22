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
import type {
  DataStore,
  ItemKey,
  ItemRecord,
  QueryPage,
  QueryRequest,
  TableDefinition,
} from '@mindlynx/metis-ports';

/**
 * The definition-driven data gateway: register a table
 * definition, get CRUD through whichever DataStore adapter is wired in.
 * The gateway validates requests against the definition; the adapter
 * owns the physical shape. It runs embedded in-process on a laptop and
 * behind a service at scale, same code.
 */
export class DataGateway {
  private readonly definitions = new Map<string, TableDefinition>();

  constructor(private readonly adapter: DataStore) {}

  registerDefinition(definition: TableDefinition): void {
    this.definitions.set(definition.name, definition);
    this.adapter.registerTable(definition);
  }

  private definitionOf(table: string): TableDefinition {
    const definition = this.definitions.get(table);
    if (!definition) throw new Error(`no definition registered for "${table}"`);
    return definition;
  }

  private assertKeyAttributes(definition: TableDefinition, item: ItemRecord): void {
    if (item[definition.partitionAttribute] === undefined) {
      throw new Error(`item is missing partition attribute "${definition.partitionAttribute}"`);
    }
    if (definition.sortAttribute && item[definition.sortAttribute] === undefined) {
      throw new Error(`item is missing sort attribute "${definition.sortAttribute}"`);
    }
  }

  async create(table: string, item: ItemRecord): Promise<void> {
    const definition = this.definitionOf(table);
    this.assertKeyAttributes(definition, item);
    await this.adapter.put(table, item, { condition: 'must-not-exist' });
  }

  async upsert(table: string, item: ItemRecord): Promise<void> {
    const definition = this.definitionOf(table);
    this.assertKeyAttributes(definition, item);
    await this.adapter.put(table, item);
  }

  async read(table: string, key: ItemKey): Promise<ItemRecord | undefined> {
    this.definitionOf(table);
    return this.adapter.get(table, key);
  }

  async update(table: string, key: ItemKey, changes: ItemRecord): Promise<void> {
    this.definitionOf(table);
    await this.adapter.patch(table, key, changes);
  }

  async remove(table: string, key: ItemKey): Promise<void> {
    this.definitionOf(table);
    await this.adapter.deleteItem(table, key);
  }

  async query(request: QueryRequest): Promise<QueryPage> {
    this.definitionOf(request.table);
    return this.adapter.query(request);
  }
}
