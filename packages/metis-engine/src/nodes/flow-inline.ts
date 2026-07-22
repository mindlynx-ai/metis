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
 * The n8n-gap flow nodes' inline execution (noop, stopanderror, merge, loop,
 * filter, comparedatasets), dispatched from the executeNode activity. Each
 * takes the ALREADY-SUBSTITUTED config; branch-shaped nodes also partition
 * their targets so empty branches orphan.
 */
import type { ExecuteNodeRequest, ExecuteNodeResult } from '../types.js';
import { partitionTargets } from './switch.js';
import { mergeSources } from './merge.js';
import { coerceArray, parseLoopConfig } from './loop.js';
import { filterItems, type FilterCondition } from './filter.js';
import { compareDatasets } from './compare.js';

export type InlineResult = {
  outcome: ExecuteNodeResult['outcome'];
  output?: unknown;
  error?: ExecuteNodeResult['error'];
};

function runStopNode(resolved: unknown): InlineResult {
  // Halt the run intentionally with the author's (template-resolved) message.
  const message = String((resolved as { message?: unknown })?.message ?? '').trim();
  return {
    outcome: 'failed',
    error: { message: message !== '' ? message : 'Stopped by a Stop and Error step' },
  };
}

function runMergeNode(resolved: unknown, request: ExecuteNodeRequest): InlineResult {
  // Join the LIVE fan-in branches' outputs; the walk already waited for all.
  const mode = (resolved as { mode?: string })?.mode;
  return { outcome: 'completed', output: mergeSources(request.sources ?? [], request.states, mode) };
}

function runLoopResolve(resolved: unknown): InlineResult {
  // Loop resolve only: the WORKFLOW drives the children (executeChild must run
  // in workflow context); the plan rides history = deterministic on replay.
  const parsed = parseLoopConfig(resolved);
  return 'error' in parsed
    ? { outcome: 'failed', error: { message: parsed.error } }
    : { outcome: 'completed', output: parsed.plan };
}

function runFilterNode(resolved: unknown, targets: { id: string; handle?: string }[]): InlineResult {
  const config = (resolved ?? {}) as { items?: unknown; conditions?: FilterCondition[] };
  const coerced = coerceArray(config.items, 'filter items');
  if ('error' in coerced) return { outcome: 'failed', error: { message: coerced.error } };
  const { kept, discarded } = filterItems(coerced.items, config.conditions ?? []);
  const selectedSources = [
    ...(kept.length > 0 ? ['kept'] : []),
    ...(discarded.length > 0 ? ['discarded'] : []),
  ];
  const partition = partitionTargets(targets, selectedSources);
  return {
    outcome: 'completed',
    output: {
      kept,
      discarded,
      keptCount: kept.length,
      discardedCount: discarded.length,
      selectedSources,
      ...partition,
    },
  };
}

function runCompareNode(resolved: unknown, targets: { id: string; handle?: string }[]): InlineResult {
  const config = (resolved ?? {}) as { itemsA?: unknown; itemsB?: unknown; matchFields?: unknown };
  const a = coerceArray(config.itemsA, 'compare itemsA');
  if ('error' in a) return { outcome: 'failed', error: { message: a.error } };
  const b = coerceArray(config.itemsB, 'compare itemsB');
  if ('error' in b) return { outcome: 'failed', error: { message: b.error } };
  const matchFields = String(config.matchFields ?? '')
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field !== '');
  if (matchFields.length === 0) {
    return { outcome: 'failed', error: { message: 'compare needs at least one match field' } };
  }
  const diff = compareDatasets(a.items, b.items, matchFields);
  const selectedSources = (['aOnly', 'same', 'different', 'bOnly'] as const).filter(
    (key) => diff[key].length > 0,
  );
  const partition = partitionTargets(targets, selectedSources);
  return {
    outcome: 'completed',
    output: {
      ...diff,
      counts: {
        aOnly: diff.aOnly.length,
        same: diff.same.length,
        different: diff.different.length,
        bOnly: diff.bOnly.length,
      },
      selectedSources,
      ...partition,
    },
  };
}

/** Run a flow node inline, or undefined when `type` is not one of them. */
export function runFlowNode(
  type: string,
  resolved: unknown,
  request: ExecuteNodeRequest,
): InlineResult | undefined {
  switch (type) {
    case 'noop':
      // No Operation: a junction/label. Passes the walk through untouched.
      return { outcome: 'completed', output: {} };
    case 'stopanderror':
      return runStopNode(resolved);
    case 'merge':
      return runMergeNode(resolved, request);
    case 'loop':
      return runLoopResolve(resolved);
    case 'filter':
      return runFilterNode(resolved, request.targets ?? []);
    case 'comparedatasets':
      return runCompareNode(resolved, request.targets ?? []);
    default:
      return undefined;
  }
}
