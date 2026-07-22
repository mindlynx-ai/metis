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
import { describe, it, expect } from 'vitest';
import { capRows, DataSourceRegistry, type DataSource } from '../data-source-port.js';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i, v: `x${i}` }));

describe('capRows', () => {
  it('returns everything, untruncated, when under both caps', () => {
    const r = capRows(rows(5), { maxRows: 10 });
    expect(r.rowCount).toBe(5);
    expect(r.truncated).toBe(false);
    expect(r.totalRows).toBeUndefined();
  });

  it('caps to maxRows and marks truncated', () => {
    const r = capRows(rows(50), { maxRows: 10 });
    expect(r.rowCount).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it('reports the real total when the caller knows it', () => {
    const r = capRows(rows(10), { maxRows: 100, total: 5000 });
    expect(r.rowCount).toBe(10);
    expect(r.totalRows).toBe(5000);
    expect(r.truncated).toBe(true);
  });

  it('trims by bytes when rows are wide, converging even on one huge row', () => {
    const wide = capRows([{ blob: 'a'.repeat(2000) }, { blob: 'b'.repeat(2000) }], {
      maxRows: 100,
      maxBytes: 1024,
    });
    expect(wide.rowCount).toBeLessThan(2);
    expect(wide.truncated).toBe(true);
    const oneHuge = capRows([{ blob: 'a'.repeat(5000) }], { maxRows: 100, maxBytes: 1024 });
    expect(oneHuge.rowCount).toBe(0);
    expect(oneHuge.truncated).toBe(true);
  });
});

describe('DataSourceRegistry', () => {
  it('registers and resolves adapters by engine', () => {
    const stub: DataSource = {
      engine: 'postgres',
      runQuery: async () => ({ rows: [], rowCount: 0, truncated: false }),
      listTables: async () => [],
      describeTable: async () => [],
    };
    const registry = new DataSourceRegistry().register(stub);
    expect(registry.get('postgres')).toBe(stub);
    expect(registry.get('athena')).toBeUndefined();
    expect(registry.engines()).toEqual(['postgres']);
  });
});
