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
 * The compare-datasets diff (n8n-gap Compare Datasets): key both arrays by the
 * match fields, then route each element to one of four sets - only in A, same
 * (all remaining fields equal), different, only in B. Pure, workflow-free.
 */

export interface CompareResult {
  aOnly: unknown[];
  same: unknown[];
  different: { a: unknown; b: unknown }[];
  bOnly: unknown[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Deterministic serialisation: object keys sorted, recursively. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function keyOf(element: unknown, matchFields: string[]): string {
  if (!isObject(element)) return canonical(element);
  return canonical(matchFields.map((field) => element[field]));
}

function rest(element: unknown, matchFields: string[]): string {
  if (!isObject(element)) return canonical(element);
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(element)) {
    if (!matchFields.includes(key)) copy[key] = value;
  }
  return canonical(copy);
}

/** Diff two datasets keyed by matchFields (first match wins per key). */
export function compareDatasets(
  itemsA: unknown[],
  itemsB: unknown[],
  matchFields: string[],
): CompareResult {
  const result: CompareResult = { aOnly: [], same: [], different: [], bOnly: [] };
  const byKeyB = new Map<string, unknown>();
  for (const element of itemsB) {
    const key = keyOf(element, matchFields);
    if (!byKeyB.has(key)) byKeyB.set(key, element);
  }
  const matchedKeys = new Set<string>();
  for (const element of itemsA) {
    const key = keyOf(element, matchFields);
    if (!byKeyB.has(key)) {
      result.aOnly.push(element);
      continue;
    }
    matchedKeys.add(key);
    const other = byKeyB.get(key);
    if (rest(element, matchFields) === rest(other, matchFields)) result.same.push(element);
    else result.different.push({ a: element, b: other });
  }
  for (const element of itemsB) {
    if (!matchedKeys.has(keyOf(element, matchFields))) result.bOnly.push(element);
  }
  return result;
}
