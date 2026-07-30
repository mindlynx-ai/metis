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

export interface PatchOptions {
  /**
   * Attribute values that must STILL hold when the write lands, compared with
   * strict equality (scalars only; a nested object is never equal to itself
   * across a round trip).
   *
   * The question is not "did the row change since patch read it" - patch reads
   * microseconds before it writes. It is "is the row still what the CALLER's
   * decision was based on", and that read can be much older: the status
   * reconciler lists running rows, then asks Temporal about each one over the
   * network, and by the time it writes the engine may have recorded the real
   * outcome. Without this the reconciler's stale answer lands last and a failed
   * run reads as completed.
   */
  ifMatches?: ItemRecord;
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

/**
 * Evaluate PatchOptions.ifMatches against the item as read. Shared by every
 * adapter so the rule has one definition rather than four that drift.
 */
export function assertMatches(existing: ItemRecord, expected: ItemRecord | undefined): void {
  for (const [name, value] of Object.entries(expected ?? {})) {
    if (existing[name] !== value) {
      throw new ConditionFailedError(
        `"${name}" is ${JSON.stringify(existing[name])}, not ${JSON.stringify(value)}`,
      );
    }
  }
}

export interface DataStore {
  registerTable(definition: TableDefinition): void;
  get(table: string, key: ItemKey): Promise<ItemRecord | undefined>;
  put(table: string, item: ItemRecord, options?: PutOptions): Promise<void>;
  /**
   * Merge attributes into an existing item. The merge base is read inside the
   * call and the write is conditional on that base still being current, so a
   * write that raced this one makes patch FAIL rather than silently discarding
   * it. `options.ifMatches` extends the same guarantee to the caller's own
   * older read.
   */
  patch(
    table: string,
    key: ItemKey,
    changes: ItemRecord,
    options?: PatchOptions,
  ): Promise<void>;
  deleteItem(table: string, key: ItemKey): Promise<void>;
  query(request: QueryRequest): Promise<QueryPage>;
}
