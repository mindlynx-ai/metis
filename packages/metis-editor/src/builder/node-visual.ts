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
 * The visual identity of a node type: its category (for colour) and an icon
 * from the Metis glyph set. Used by the workflow-list chain preview and the
 * builder canvas nodes, so a step looks the same wherever it appears.
 */
import type { CatalogueEntry } from '../api.js';
import type { IconName } from '../ui/Icon.js';

const OPEN_CATEGORIES = new Set(['trigger', 'logic', 'transform', 'integration']);

/** A specific icon per node type, falling back to a per-category default. */
const TYPE_ICON: Record<string, IconName> = {
  webhookconfig: 'webhook',
  apiconfig: 'globe',
  apiend: 'flag',
  scheduleconfig: 'clock',
  signal: 'bolt',
  switch: 'branch',
  logic: 'branch',
  waituntil: 'clock',
  noop: 'minus',
  stopanderror: 'alert',
  merge: 'link',
  loop: 'refresh',
  filter: 'search',
  comparedatasets: 'grid',
  code: 'code',
  transform: 'code',
  api: 'globe',
  http: 'globe',
  connector: 'plug',
  postgres: 'database',
  sendgrid: 'mail',
};

const CATEGORY_ICON: Record<string, IconName> = {
  trigger: 'bolt',
  logic: 'branch',
  transform: 'code',
  integration: 'globe',
};

export function categoryOf(type: string, catalogue: CatalogueEntry[]): string {
  const entry = catalogue.find((candidate) => candidate.type === type);
  const category = entry?.category ?? 'integration';
  return OPEN_CATEGORIES.has(category) ? category : 'integration';
}

export function nodeIcon(type: string, category: string): IconName {
  return TYPE_ICON[type.toLowerCase()] ?? CATEGORY_ICON[category] ?? 'workflow';
}

/**
 * A node's output ports - the handles an edge leaves from. `id` becomes the
 * edge's sourceHandle, and it MUST match what the engine routes by, or the edge
 * a user draws points at a branch that never fires:
 *   - a `switch` routes by `source-<optionId>` (one per switchOption) and
 *     `source-default` for the fall-through;
 *   - a `logic` node routes by `true` / `false`;
 *   - everything else has one unnamed output (sourceHandle null connects it).
 * `top` positions the handle vertically on the node's right edge.
 */
export interface OutputPort {
  id?: string;
  label?: string;
  top: string;
}

interface SwitchOption {
  id?: string;
  name?: string;
}

/** Evenly space N handles down the right edge (2 -> 33/67, 3 -> 25/50/75). */
function spread(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${Math.round(((i + 1) / (count + 1)) * 100)}%`);
}

export function outputPorts(nodeType: string, config?: Record<string, unknown>): OutputPort[] {
  const type = nodeType.toLowerCase();
  // Stop and Error is terminal: the run halts here, so there is nothing to
  // wire onwards and no output handle to offer.
  if (type === 'stopanderror') return [];
  if (type === 'switch') {
    const options = (Array.isArray(config?.switchOptions) ? config.switchOptions : []) as SwitchOption[];
    const branches = options
      .filter((option) => option?.id)
      .map((option) => ({ id: `source-${option.id}`, label: option.name || String(option.id) }));
    // The fall-through branch is always present (the engine's source-default).
    branches.push({ id: 'source-default', label: 'Otherwise' });
    const tops = spread(branches.length);
    return branches.map((branch, index) => ({ ...branch, top: tops[index] ?? '50%' }));
  }
  if (type === 'logic') {
    return [
      { id: 'true', label: 'Yes', top: '32%' },
      { id: 'false', label: 'No', top: '68%' },
    ];
  }
  if (type === 'loop') {
    // The engine iterates the 'each' subgraph as a child workflow per batch
    // and continues down 'done' with the collected results.
    return [
      { id: 'each', label: 'Each item', top: '32%' },
      { id: 'done', label: 'Done', top: '68%' },
    ];
  }
  if (type === 'filter') {
    return [
      { id: 'kept', label: 'Kept', top: '32%' },
      { id: 'discarded', label: 'Discarded', top: '68%' },
    ];
  }
  if (type === 'comparedatasets') {
    return [
      { id: 'aOnly', label: 'In A only', top: '20%' },
      { id: 'same', label: 'Same', top: '40%' },
      { id: 'different', label: 'Different', top: '60%' },
      { id: 'bOnly', label: 'In B only', top: '80%' },
    ];
  }
  return [{ top: '50%' }];
}

/** Triggers have no input; every other node accepts one. */
export function hasInput(category: string): boolean {
  return category !== 'trigger';
}
