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
 * Pure logic for the Data node's visual builder, separated from the React
 * component: the builder state <-> handler config mapping, validated columns ->
 * output variables, and the table-search filter. No React, so it is trivially
 * unit-tested.
 */

export const NEEDS_WHERE = new Set(['select', 'update', 'delete']);
export const NEEDS_VALUES = new Set(['insert', 'update']);

export interface WhereRow {
  column: string;
  operator: string;
  value: string;
}
export interface ValueRow {
  column: string;
  value: string;
}
export interface BuilderState {
  mode: 'sql' | 'build';
  query: string;
  operation: string;
  table: string;
  where: WhereRow[];
  values: ValueRow[];
}
export interface DataColumn {
  name: string;
  type?: string;
}

/** The config keys the Data handler reads, from the builder state. The inactive
 *  mode's keys are cleared (undefined) so raw SQL and the builder never clash. */
export function toDataConfig(state: BuilderState): Record<string, unknown> {
  if (state.mode === 'sql') {
    return { mode: 'sql', query: state.query || undefined, operation: undefined, tables: undefined, where: undefined };
  }
  const values = state.values.filter((row) => row.column.trim() !== '');
  const valueObj = Object.fromEntries(values.map((row) => [row.column.trim(), row.value]));
  const where = state.where.filter((row) => row.column.trim() !== '');
  const table = state.table.trim();
  return {
    mode: 'build',
    query: undefined,
    operation: state.operation,
    tables: table ? [{ name: table, ...(values.length > 0 ? { values: valueObj } : {}) }] : [],
    where: NEEDS_WHERE.has(state.operation) && where.length > 0 ? where : undefined,
  };
}

/** The node.data.outputs a validated column set declares. Keyed `row.<col>` so a
 *  downstream step references the first record's field: {{step.data.row.email}}. */
export function columnsToOutputs(
  columns: DataColumn[],
): { manualData: { key: string; type: string; value: string }[] }[] {
  if (columns.length === 0) return [];
  return [
    { manualData: columns.map((column) => ({ key: `row.${column.name}`, type: column.type ?? 'string', value: '' })) },
  ];
}

/** The output keys currently declared on a node instance (to skip a no-op write). */
export function outputsKey(outputs: unknown): string {
  const rows = (outputs as { manualData?: { key?: string }[] }[] | undefined)?.[0]?.manualData ?? [];
  return rows.map((row) => row.key).join(',');
}

/** Case-insensitive substring filter for the table browser (many-table search). */
export function filterTables(tables: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  return q === '' ? tables : tables.filter((table) => table.toLowerCase().includes(q));
}

/** Read the builder state back out of a stored config (the reverse of toDataConfig). */
export function seedFrom(config: Record<string, unknown>): BuilderState {
  const tables = (config.tables ?? []) as { name?: string; values?: Record<string, unknown> }[];
  const first = tables[0];
  const values = Object.entries(first?.values ?? {}).map(([column, value]) => ({
    column,
    value: String(value ?? ''),
  }));
  const where = ((config.where ?? []) as { column?: string; operator?: string; value?: unknown }[]).map(
    (row) => ({ column: row.column ?? '', operator: row.operator ?? '=', value: String(row.value ?? '') }),
  );
  const hasBuild = Boolean(config.operation) && !config.query;
  return {
    mode: config.mode === 'build' || hasBuild ? 'build' : 'sql',
    query: String(config.query ?? ''),
    operation: String(config.operation ?? 'select'),
    table: first?.name ?? '',
    where,
    values,
  };
}
