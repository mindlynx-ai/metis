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
import {
  columnsToOutputs,
  filterTables,
  seedFrom,
  tableKey,
  tableLabels,
  toDataConfig,
} from '../builder/inspector/data-builder-config.js';

describe('toDataConfig (visual builder -> handler config)', () => {
  it('SQL mode writes the query and clears the builder keys', () => {
    expect(
      toDataConfig({ mode: 'sql', query: 'select 1', operation: 'select', table: 'orders', schema: '', where: [], values: [] }),
    ).toEqual({ mode: 'sql', query: 'select 1', operation: undefined, tables: undefined, where: undefined });
  });

  it('build select writes operation + table + filters, and drops blank rows', () => {
    const config = toDataConfig({
      mode: 'build',
      query: '',
      operation: 'select',
      table: 'orders',
      schema: '',
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
      schema: '',
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
    const config = toDataConfig({ mode: 'build', query: '', operation: 'select', table: '', schema: '', where: [], values: [] });
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
  const named = (name: string, schema?: string) => ({ name, schema });
  const tables = [named('orders'), named('order_items'), named('customers'), named('products')];
  it('matches case-insensitive substrings', () => {
    expect(filterTables(tables, 'ORDER')).toEqual([named('orders'), named('order_items')]);
    expect(filterTables(tables, 'cust')).toEqual([named('customers')]);
  });
  it('returns everything for a blank query', () => {
    expect(filterTables(tables, '  ')).toEqual(tables);
  });
  it('returns nothing when no table matches', () => {
    expect(filterTables(tables, 'zzz')).toEqual([]);
  });
  it('searches the schema too, so one schema can be narrowed to', () => {
    const across = [named('items', 'billing'), named('items', 'shipping')];
    expect(filterTables(across, 'shipping')).toEqual([named('items', 'shipping')]);
  });
});

describe('tableKey and tableLabels (same name, different schema)', () => {
  const named = (name: string, schema?: string) => ({ name, schema });

  it('keys a table by its schema, so two of one name stay apart', () => {
    expect(tableKey(named('items', 'billing'))).toBe('billing.items');
    expect(tableKey(named('items', 'shipping'))).toBe('shipping.items');
    expect(tableKey(named('orders'))).toBe('orders');
  });

  it('qualifies a label ONLY when the bare name is ambiguous', () => {
    // The reason this matters: a picker showing `items` twice asks the reader
    // to choose at random, and choosing wrong reads a different table without
    // any error at all.
    const labels = tableLabels([named('items', 'billing'), named('items', 'shipping'), named('orders', 'public')]);
    expect(labels.map((entry) => entry.label)).toEqual(['billing.items', 'shipping.items', 'orders']);
  });
});

describe('the schema survives the round trip', () => {
  const state = {
    mode: 'build' as const,
    query: '',
    operation: 'select',
    table: 'items',
    schema: 'billing',
    where: [],
    values: [],
  };

  it('is written into the config the handler reads', () => {
    expect(toDataConfig(state).schema).toBe('billing');
  });

  it('comes back out of a stored config', () => {
    expect(seedFrom(toDataConfig(state)).schema).toBe('billing');
  });

  it('is left unset for a typed-in name, meaning the default schema', () => {
    expect(toDataConfig({ ...state, schema: '' }).schema).toBeUndefined();
  });

  it('never rides along with hand-written SQL, which qualifies its own names', () => {
    expect(toDataConfig({ ...state, mode: 'sql', query: 'select 1 from shipping.items' }).schema).toBeUndefined();
  });
});
