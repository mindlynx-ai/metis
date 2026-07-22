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
import { columnsToOutputs, filterTables, toDataConfig } from '../builder/inspector/data-builder-config.js';

describe('toDataConfig (visual builder -> handler config)', () => {
  it('SQL mode writes the query and clears the builder keys', () => {
    expect(
      toDataConfig({ mode: 'sql', query: 'select 1', operation: 'select', table: 'orders', where: [], values: [] }),
    ).toEqual({ mode: 'sql', query: 'select 1', operation: undefined, tables: undefined, where: undefined });
  });

  it('build select writes operation + table + filters, and drops blank rows', () => {
    const config = toDataConfig({
      mode: 'build',
      query: '',
      operation: 'select',
      table: 'orders',
      where: [
        { column: 'status', operator: '=', value: 'paid' },
        { column: '', operator: '=', value: '' },
      ],
      values: [],
    });
    expect(config).toMatchObject({
      mode: 'build',
      operation: 'select',
      tables: [{ name: 'orders' }],
      where: [{ column: 'status', operator: '=', value: 'paid' }],
    });
    // Build mode never leaves a stale raw query behind.
    expect(config.query).toBeUndefined();
  });

  it('build insert writes values onto the table and ignores where', () => {
    const config = toDataConfig({
      mode: 'build',
      query: '',
      operation: 'insert',
      table: 'orders',
      where: [{ column: 'x', operator: '=', value: '1' }],
      values: [
        { column: 'customer', value: 'Ada' },
        { column: '', value: '' },
      ],
    });
    expect(config).toMatchObject({ operation: 'insert', tables: [{ name: 'orders', values: { customer: 'Ada' } }] });
    expect(config.where).toBeUndefined();
  });

  it('build with no table yields an empty tables array (nothing to run yet)', () => {
    const config = toDataConfig({ mode: 'build', query: '', operation: 'select', table: '', where: [], values: [] });
    expect(config.tables).toEqual([]);
  });
});

describe('columnsToOutputs (validated columns -> node output variables)', () => {
  it('keys each column row.<col> so a downstream step references the first record', () => {
    expect(columnsToOutputs([{ name: 'email', type: 'text' }, { name: 'amount', type: 'numeric' }])).toEqual([
      {
        manualData: [
          { key: 'row.email', type: 'text', value: '' },
          { key: 'row.amount', type: 'numeric', value: '' },
        ],
      },
    ]);
  });

  it('declares nothing for no columns', () => {
    expect(columnsToOutputs([])).toEqual([]);
  });
});

describe('filterTables (the many-table browser search)', () => {
  const tables = ['orders', 'order_items', 'customers', 'products'];
  it('matches case-insensitive substrings', () => {
    expect(filterTables(tables, 'ORDER')).toEqual(['orders', 'order_items']);
    expect(filterTables(tables, 'cust')).toEqual(['customers']);
  });
  it('returns everything for a blank query', () => {
    expect(filterTables(tables, '  ')).toEqual(tables);
  });
  it('returns nothing when no table matches', () => {
    expect(filterTables(tables, 'zzz')).toEqual([]);
  });
});
