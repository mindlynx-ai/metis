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
import { columnsFromFields, isWrappableSelect, wrapForLimit } from '../postgres-data-source.js';

describe('isWrappableSelect', () => {
  it('accepts a single SELECT or WITH statement', () => {
    expect(isWrappableSelect('select * from orders')).toBe(true);
    expect(isWrappableSelect('  SELECT id FROM t WHERE x = 1  ')).toBe(true);
    expect(isWrappableSelect('with q as (select 1) select * from q')).toBe(true);
    expect(isWrappableSelect('select * from orders;')).toBe(true); // trailing ; is fine
  });

  it('rejects writes and multi-statement SQL (do not wrap those)', () => {
    expect(isWrappableSelect('insert into t values (1) returning *')).toBe(false);
    expect(isWrappableSelect('update t set x = 1 returning *')).toBe(false);
    expect(isWrappableSelect('select 1; drop table t')).toBe(false);
  });
});

describe('wrapForLimit', () => {
  it('wraps a read query so the source caps the fetch at maxRows+1', () => {
    expect(wrapForLimit('select * from orders', 1000)).toBe(
      'SELECT * FROM (select * from orders) AS _capped LIMIT 1001',
    );
    // trailing semicolon is stripped so the wrap stays valid
    expect(wrapForLimit('select 1;', 10)).toBe('SELECT * FROM (select 1) AS _capped LIMIT 11');
  });
});

describe('columnsFromFields', () => {
  it('maps pg field OIDs to friendly type names (unknown OIDs fall back)', () => {
    expect(
      columnsFromFields([
        { name: 'email', dataTypeID: 25 },
        { name: 'amount', dataTypeID: 1700 },
        { name: 'created_at', dataTypeID: 1184 },
        { name: 'weird', dataTypeID: 99999 },
      ]),
    ).toEqual([
      { name: 'email', type: 'text' },
      { name: 'amount', type: 'numeric' },
      { name: 'created_at', type: 'timestamptz' },
      { name: 'weird', type: 'unknown' },
    ]);
  });
});
