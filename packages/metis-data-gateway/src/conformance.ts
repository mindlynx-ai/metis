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
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { ConditionFailedError, type DataStore } from '@mindlynx/metis-ports';

export interface ConformanceHarness {
  adapter: DataStore;
  teardown?: () => Promise<void> | void;
}

export type ConformanceFactory = () => Promise<ConformanceHarness> | ConformanceHarness;

const TABLE = 'conformance_items';

/**
 * The DataStore conformance suite. Every
 * adapter must pass it unmodified; a semantic disagreement between
 * adapters is resolved by amending this suite, never by loosening an
 * adapter. The in-memory reference adapter is the executable authority.
 */
export function runDataStoreConformance(name: string, factory: ConformanceFactory): void {
  describe(`DataStore conformance: ${name}`, () => {
    let adapter: DataStore;
    let teardown: (() => Promise<void> | void) | undefined;

    beforeEach(async () => {
      const harness = await factory();
      adapter = harness.adapter;
      teardown = harness.teardown;
      adapter.registerTable({
        name: TABLE,
        partitionAttribute: 'PK',
        sortAttribute: 'SK',
        indexes: [
          { name: 'byOwner', partitionAttribute: 'owner', sortAttribute: 'updatedAt' },
          { name: 'byStatus', partitionAttribute: 'statusKey', sortAttribute: 'updatedAt' },
        ],
      });
    });

    afterAll(async () => {
      await teardown?.();
    });

    const seed = async (items: Record<string, unknown>[]) => {
      for (const item of items) await adapter.put(TABLE, item);
    };

    it('round-trips an item by partition and sort key', async () => {
      await adapter.put(TABLE, { PK: 'p1', SK: 's1', payload: { nested: [1, 2] }, n: 7 });
      const item = await adapter.get(TABLE, { partitionKey: 'p1', sortKey: 's1' });
      expect(item?.payload).toEqual({ nested: [1, 2] });
      expect(item?.n).toBe(7);
      expect(await adapter.get(TABLE, { partitionKey: 'p1', sortKey: 'missing' })).toBeUndefined();
    });

    it('put replaces the whole item', async () => {
      await adapter.put(TABLE, { PK: 'p1', SK: 's1', a: 1, b: 2 });
      await adapter.put(TABLE, { PK: 'p1', SK: 's1', a: 9 });
      const item = await adapter.get(TABLE, { partitionKey: 'p1', sortKey: 's1' });
      expect(item?.a).toBe(9);
      expect(item?.b).toBeUndefined();
    });

    it('enforces conditional writes by key', async () => {
      await adapter.put(TABLE, { PK: 'p1', SK: 's1' }, { condition: 'must-not-exist' });
      await expect(
        adapter.put(TABLE, { PK: 'p1', SK: 's1' }, { condition: 'must-not-exist' }),
      ).rejects.toThrow(ConditionFailedError);
      await expect(
        adapter.put(TABLE, { PK: 'p1', SK: 'absent' }, { condition: 'must-exist' }),
      ).rejects.toThrow(ConditionFailedError);
      await adapter.put(TABLE, { PK: 'p1', SK: 's1', v: 2 }, { condition: 'must-exist' });
      expect((await adapter.get(TABLE, { partitionKey: 'p1', sortKey: 's1' }))?.v).toBe(2);
    });

    it('patch merges attributes and rejects a missing item', async () => {
      await adapter.put(TABLE, { PK: 'p1', SK: 's1', status: 'running', keep: true });
      await adapter.patch(TABLE, { partitionKey: 'p1', sortKey: 's1' }, { status: 'completed' });
      const item = await adapter.get(TABLE, { partitionKey: 'p1', sortKey: 's1' });
      expect(item?.status).toBe('completed');
      expect(item?.keep).toBe(true);
      await expect(
        adapter.patch(TABLE, { partitionKey: 'p1', sortKey: 'absent' }, { status: 'x' }),
      ).rejects.toThrow(ConditionFailedError);
    });

    it('deletes by key and tolerates deleting a missing item', async () => {
      await adapter.put(TABLE, { PK: 'p1', SK: 's1' });
      await adapter.deleteItem(TABLE, { partitionKey: 'p1', sortKey: 's1' });
      expect(await adapter.get(TABLE, { partitionKey: 'p1', sortKey: 's1' })).toBeUndefined();
      await adapter.deleteItem(TABLE, { partitionKey: 'p1', sortKey: 's1' });
    });

    it('queries a partition in ascending sort order by default', async () => {
      await seed([
        { PK: 'p1', SK: 'c' },
        { PK: 'p1', SK: 'a' },
        { PK: 'p1', SK: 'b' },
        { PK: 'other', SK: 'a' },
      ]);
      const page = await adapter.query({ table: TABLE, partitionValue: 'p1' });
      expect(page.items.map((i) => i.SK)).toEqual(['a', 'b', 'c']);
    });

    it('sorts in binary code-point order, not locale order', async () => {
      await seed([
        { PK: 'p1', SK: 'a' },
        { PK: 'p1', SK: 'Z' },
        { PK: 'p1', SK: '0' },
        { PK: 'p1', SK: '#' },
      ]);
      const page = await adapter.query({ table: TABLE, partitionValue: 'p1' });
      expect(page.items.map((i) => i.SK)).toEqual(['#', '0', 'Z', 'a']);
    });

    it('queries descending when asked', async () => {
      await seed([
        { PK: 'p1', SK: 'a' },
        { PK: 'p1', SK: 'b' },
      ]);
      const page = await adapter.query({ table: TABLE, partitionValue: 'p1', ascending: false });
      expect(page.items.map((i) => i.SK)).toEqual(['b', 'a']);
    });

    it('filters by sort-key prefix and by range', async () => {
      await seed([
        { PK: 'p1', SK: 'VER#1#0' },
        { PK: 'p1', SK: 'VER#2#0' },
        { PK: 'p1', SK: 'META' },
        { PK: 'p1', SK: 'LOG#001' },
        { PK: 'p1', SK: 'LOG#002' },
      ]);
      const versions = await adapter.query({ table: TABLE, partitionValue: 'p1', sortPrefix: 'VER#' });
      expect(versions.items.map((i) => i.SK)).toEqual(['VER#1#0', 'VER#2#0']);
      const logs = await adapter.query({
        table: TABLE,
        partitionValue: 'p1',
        sortRange: { from: 'LOG#001', to: 'LOG#001~' },
      });
      expect(logs.items.map((i) => i.SK)).toEqual(['LOG#001']);
    });

    it('pages with limit and cursor, cursor present only when more items exist', async () => {
      await seed([1, 2, 3, 4].map((n) => ({ PK: 'p1', SK: `s${n}`, n })));
      const first = await adapter.query({ table: TABLE, partitionValue: 'p1', limit: 2 });
      expect(first.items.map((i) => i.n)).toEqual([1, 2]);
      expect(first.cursor).toBeDefined();
      const second = await adapter.query({
        table: TABLE,
        partitionValue: 'p1',
        limit: 2,
        cursor: first.cursor,
      });
      expect(second.items.map((i) => i.n)).toEqual([3, 4]);
      expect(second.cursor).toBeUndefined();
    });

    it('keeps cursors stable under interleaved inserts', async () => {
      await seed([
        { PK: 'p1', SK: 'b' },
        { PK: 'p1', SK: 'd' },
        { PK: 'p1', SK: 'f' },
      ]);
      const first = await adapter.query({ table: TABLE, partitionValue: 'p1', limit: 2 });
      expect(first.items.map((i) => i.SK)).toEqual(['b', 'd']);
      await adapter.put(TABLE, { PK: 'p1', SK: 'a' });
      await adapter.put(TABLE, { PK: 'p1', SK: 'e' });
      const second = await adapter.query({
        table: TABLE,
        partitionValue: 'p1',
        cursor: first.cursor,
      });
      expect(second.items.map((i) => i.SK)).toEqual(['e', 'f']);
    });

    it('queries a secondary index with its own sort order', async () => {
      await seed([
        { PK: 'p1', SK: 's1', owner: 'o1', updatedAt: '2026-01-02' },
        { PK: 'p2', SK: 's1', owner: 'o1', updatedAt: '2026-01-01' },
        { PK: 'p3', SK: 's1', owner: 'o2', updatedAt: '2026-01-03' },
      ]);
      const page = await adapter.query({
        table: TABLE,
        index: 'byOwner',
        partitionValue: 'o1',
        ascending: false,
      });
      expect(page.items.map((i) => i.PK)).toEqual(['p1', 'p2']);
    });

    it('treats secondary indexes as sparse: items without the index attribute are absent', async () => {
      await seed([
        { PK: 'p1', SK: 'META', statusKey: 'running', updatedAt: '2026-01-01' },
        { PK: 'p1', SK: 'LOG#001' },
      ]);
      const page = await adapter.query({ table: TABLE, index: 'byStatus', partitionValue: 'running' });
      expect(page.items.map((i) => i.SK)).toEqual(['META']);
    });

    it('treats null index attributes as absent (a patch to null unlists an item)', async () => {
      await seed([
        { PK: 'p1', SK: 'META', statusKey: 'running', updatedAt: '2026-01-01' },
        { PK: 'p2', SK: 'META', statusKey: 'running', updatedAt: '2026-01-02' },
      ]);
      await adapter.patch(
        TABLE,
        { partitionKey: 'p1', sortKey: 'META' },
        { statusKey: null, updatedAt: null },
      );
      const page = await adapter.query({ table: TABLE, index: 'byStatus', partitionValue: 'running' });
      expect(page.items.map((i) => i.PK)).toEqual(['p2']);
      const direct = await adapter.get(TABLE, { partitionKey: 'p1', sortKey: 'META' });
      expect(direct?.PK).toBe('p1');
    });

    it('pages a secondary index with a cursor', async () => {
      await seed(
        [1, 2, 3].map((n) => ({ PK: `p${n}`, SK: 's', owner: 'o1', updatedAt: `2026-01-0${n}` })),
      );
      const first = await adapter.query({
        table: TABLE,
        index: 'byOwner',
        partitionValue: 'o1',
        limit: 2,
      });
      expect(first.items).toHaveLength(2);
      const second = await adapter.query({
        table: TABLE,
        index: 'byOwner',
        partitionValue: 'o1',
        cursor: first.cursor,
      });
      expect(second.items).toHaveLength(1);
      expect(second.cursor).toBeUndefined();
    });

    it('supports tables with a partition key only', async () => {
      adapter.registerTable({ name: 'flat_items', partitionAttribute: 'id' });
      await adapter.put('flat_items', { id: 'x', v: 1 });
      expect((await adapter.get('flat_items', { partitionKey: 'x' }))?.v).toBe(1);
    });

    it('rejects operations on unregistered tables and unknown indexes', async () => {
      await expect(adapter.get('nowhere', { partitionKey: 'p' })).rejects.toThrow(/not registered/i);
      await expect(
        adapter.query({ table: TABLE, index: 'missing', partitionValue: 'p' }),
      ).rejects.toThrow(/index/i);
    });
  });
}
