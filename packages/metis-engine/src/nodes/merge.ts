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
 * The merge node's join logic (n8n-gap): combine the outputs of the LIVE fan-in
 * branches into one payload. The graph walk already waited for every source
 * (the convergence join), so this only shapes the data:
 *   - append:  { items: [dataA, dataB, ...], count } in edge order
 *   - combine: shallow object merge, later sources winning
 *   - pick:    the first live source's data, unchanged
 * Orphaned sources (a switch's dead branch) are excluded. Pure, so it is
 * unit-testable without a workflow.
 */
import type { NodeStateEntry } from '../types.js';

export type MergeMode = 'append' | 'combine' | 'pick';

export interface MergeSource {
  id: string;
  orphaned: boolean;
}

/** The latest recorded output of a node, from the workflow state entries. */
function latestData(states: NodeStateEntry[], nodeId: string): unknown {
  for (let i = states.length - 1; i >= 0; i -= 1) {
    const entry = states[i];
    if (entry && entry.nodeId === nodeId && entry.stateData !== undefined) {
      return entry.stateData.data;
    }
  }
  return undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Join the live sources' outputs by mode (see the file header). */
export function mergeSources(
  sources: MergeSource[],
  states: NodeStateEntry[],
  mode: string | undefined,
): unknown {
  const live = sources.filter((source) => !source.orphaned);
  const datas = live
    .map((source) => latestData(states, source.id))
    .filter((data) => data !== undefined);

  switch ((mode ?? 'append').toLowerCase()) {
    case 'combine':
      return Object.assign({}, ...datas.filter(isObject)) as Record<string, unknown>;
    case 'pick':
      return datas[0] ?? {};
    default:
      return { items: datas, count: datas.length };
  }
}
