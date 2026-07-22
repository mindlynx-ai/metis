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
 * The DataStore port. The generic contract
 * is get, put, query, conditional-write by key and secondary-index
 * lookups. Adapters (in-memory reference, SQLite, Postgres) implement
 * this seam; the workflow-specific method set layers
 * over it in the data gateway.
 */
export type ItemRecord = Record<string, unknown>;

export interface ItemKey {
  partitionKey: string;
  sortKey?: string;
}

export interface TableIndexDefinition {
  name: string;
  partitionAttribute: string;
  sortAttribute?: string;
}

export interface TableDefinition {
  name: string;
  partitionAttribute: string;
  sortAttribute?: string;
  indexes?: TableIndexDefinition[];
  ttlAttribute?: string;
}

export interface PutOptions {
  condition?: 'must-exist' | 'must-not-exist';
}

export interface QueryRequest {
  table: string;
  index?: string;
  partitionValue: string;
  sortPrefix?: string;
  sortRange?: { from?: string; to?: string };
  ascending?: boolean;
  limit?: number;
  cursor?: string;
}

export interface QueryPage {
  items: ItemRecord[];
  cursor?: string;
}

export class ConditionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConditionFailedError';
  }
}

export interface DataStore {
  registerTable(definition: TableDefinition): void;
  get(table: string, key: ItemKey): Promise<ItemRecord | undefined>;
  put(table: string, item: ItemRecord, options?: PutOptions): Promise<void>;
  patch(table: string, key: ItemKey, changes: ItemRecord): Promise<void>;
  deleteItem(table: string, key: ItemKey): Promise<void>;
  query(request: QueryRequest): Promise<QueryPage>;
}
