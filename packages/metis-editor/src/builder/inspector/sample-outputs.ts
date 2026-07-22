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
 * Declaring a trigger's outputs from a pasted sample request. A trigger node
 * never executes, so it cannot discover its own shape - the author pastes an
 * example body and we infer one level of keys (matching the origin's
 * paste-a-sample affordance). The keys become `data.outputs`, which the
 * variable picker then offers to downstream steps.
 *
 * A webhook seeds its body under the envelope (`data.body.<key>`), so its rows
 * are prefixed `body.`; an api workflow seeds the body directly, so no prefix.
 * ponytail: one level deep, like the origin. Add nested inference when a real
 * payload needs it, not before.
 */

export interface SampleOutputRow {
  key: string;
  type: string;
  value: unknown;
}

export interface InferResult {
  rows: SampleOutputRow[];
  error?: string;
}

/** The JSON type name for a value, distinguishing null and array from object. */
function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function inferSampleOutputs(sample: string, prefix = ''): InferResult {
  const trimmed = sample.trim();
  if (trimmed === '') return { rows: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { rows: [], error: 'That is not valid JSON. Paste an example request body.' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { rows: [], error: 'Paste a JSON object, for example {"firstName":"Ada"}.' };
  }

  const rows = Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({
    key: `${prefix}${key}`,
    type: jsonTypeOf(value),
    value,
  }));
  return { rows };
}

/** Wrap inferred rows in the `[{ manualData }]` envelope `data.outputs` expects. */
export function outputsFromRows(rows: SampleOutputRow[]): unknown[] {
  return rows.length === 0 ? [] : [{ manualData: rows }];
}
