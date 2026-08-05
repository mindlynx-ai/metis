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
 * What the audit read asks the store for. The reply was always bounded, so
 * this is about the request: an install that has been running for a year must
 * not have to load a year of history to answer "what just happened", and the
 * two filters that are matched after the read must keep loading it, because
 * bounding those would change the answer rather than the cost.
 */
import { describe, it, expect } from 'vitest';
import type { QueryRequest } from '@mindlynx/metis-ports';
import { DataGateway } from '../gateway.js';
import { MemoryAdapter } from '../memory-adapter.js';
import { AuditStore, registerAuditTable } from '../audit-store.js';

const build = () => {
  const gateway = new DataGateway(new MemoryAdapter());
  registerAuditTable(gateway);
  const asked: QueryRequest[] = [];
  const inner = gateway.query.bind(gateway);
  gateway.query = (request: QueryRequest) => {
    asked.push(request);
    return inner(request);
  };
  return { store: new AuditStore(gateway), asked };
};

/** `count` entries, oldest first, so entry `count` is the newest. */
const fill = async (store: AuditStore, count: number, actor = 'ada') => {
  for (let i = 1; i <= count; i += 1) {
    await store.record({
      tenantId: 't1',
      actor,
      action: 'workflow.published',
      entityType: 'workflow',
      entityId: `wf-${i}`,
      at: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
    });
  }
};

describe('the audit read is bounded at the store, not after it', () => {
  it('asks for the newest fifty rather than the whole history', async () => {
    const { store, asked } = build();
    await fill(store, 60);
    const items = await store.list('t1');
    expect(asked).toEqual([
      expect.objectContaining({ limit: 50, ascending: false, partitionValue: 'AUDIT#t1' }),
    ]);
    // Newest first, and the newest FIFTY: taking a limit without reversing the
    // read would have answered with the oldest fifty instead.
    expect(items).toHaveLength(50);
    expect(items[0].entityId).toBe('wf-60');
    expect(items[49].entityId).toBe('wf-11');
  });

  it('caps an outsized limit and floors a nonsense one', async () => {
    const { store, asked } = build();
    await fill(store, 3);
    await store.list('t1', { limit: 100_000 });
    await store.list('t1', { limit: 0 });
    expect(asked.map((request) => request.limit)).toEqual([500, 1]);
  });

  it('bounds an actor read too, on the index that already narrows it', async () => {
    const { store, asked } = build();
    await fill(store, 60, 'ada');
    const items = await store.list('t1', { actor: 'ada', limit: 5 });
    expect(asked).toEqual([
      expect.objectContaining({ index: 'byActor', limit: 5, ascending: false }),
    ]);
    expect(items.map((item) => item.entityId)).toEqual(['wf-60', 'wf-59', 'wf-58', 'wf-57', 'wf-56']);
  });

  it('leaves an entity read unbounded, because bounding it would lose the answer', async () => {
    const { store, asked } = build();
    await fill(store, 60);
    // wf-1 is the OLDEST entry. A read bounded to the newest fifty would not
    // have reached it, and would have reported that nothing ever happened to
    // it - which is the one thing an audit trail may not do.
    const items = await store.list('t1', { entityId: 'wf-1' });
    expect(asked[0].limit).toBeUndefined();
    expect(items.map((item) => item.entityId)).toEqual(['wf-1']);
  });

  it('leaves an action read unbounded for the same reason', async () => {
    const { store, asked } = build();
    await fill(store, 60);
    await store.record({
      tenantId: 't1',
      actor: 'ada',
      action: 'connection.deleted',
      entityType: 'connection',
      entityId: 'conn-1',
      at: '2026-01-01T00:00:30.000Z',
    });
    const items = await store.list('t1', { action: 'connection.deleted' });
    expect(asked[asked.length - 1].limit).toBeUndefined();
    expect(items.map((item) => item.entityId)).toEqual(['conn-1']);
  });
});
