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
 * Where a RUNNING execution genuinely is - the thing Temporal never answers
 * plainly. Derived from the engine's own store logs: a node that logged
 * `workflow.node.waiting` and has not completed means the run is PARKED
 * (signal / human-in-the-loop / wait-until); otherwise the latest started,
 * uncompleted node is where work is happening right now.
 */

export interface Whereabouts {
  runState: 'waiting' | 'running';
  /** Present when parked: what the run waits for. */
  waitingOn?: { signalType?: string; until?: string };
  /** Present when actively working: the current step's label (or type). */
  atNode?: string;
}

type LogRow = Record<string, unknown>;

export function deriveWhereabouts(
  logs: LogRow[],
  labelOf: (nodeId: string) => string | undefined,
): Whereabouts {
  const finished = new Set<string>();
  const startedNodes = new Set<string>();
  for (const row of logs) {
    const event = String(row.event ?? '');
    if (event.endsWith('node.completed') || event.endsWith('node.failed')) {
      finished.add(String(row.nodeId ?? ''));
    }
    if (event.endsWith('node.started')) startedNodes.add(String(row.nodeId ?? ''));
  }
  const latest = (suffix: string, exclude: Set<string>): LogRow | undefined => {
    for (let i = logs.length - 1; i >= 0; i -= 1) {
      const row = logs[i]!;
      if (String(row.event ?? '').endsWith(suffix) && !exclude.has(String(row.nodeId ?? ''))) {
        return row;
      }
    }
    return undefined;
  };

  // A node that STARTED was resumed from its park - dispatch only happens
  // after the wait, so a started row disqualifies the waiting record.
  const parkExcluded = new Set([...finished, ...startedNodes]);
  const parked = latest('node.waiting', parkExcluded);
  if (parked) {
    const signalType = typeof parked.signalType === 'string' && parked.signalType !== '' ? parked.signalType : undefined;
    const until = typeof parked.until === 'string' ? parked.until : undefined;
    return { runState: 'waiting', waitingOn: { signalType, until } };
  }
  const active = latest('node.started', finished);
  if (active) {
    const nodeId = String(active.nodeId ?? '');
    return { runState: 'running', atNode: labelOf(nodeId) ?? String(active.nodeType ?? nodeId) };
  }
  return { runState: 'running' };
}

/** node id -> label lookup from a stored definition (wire or engine shape). */
export function labelMapOf(definition: unknown): Map<string, string> {
  const map = new Map<string, string>();
  const nodes = (definition as { nodes?: unknown[] } | undefined)?.nodes ?? [];
  for (const node of nodes) {
    const item = node as { id?: unknown; label?: unknown; data?: { label?: unknown } };
    const label = item.data?.label ?? item.label;
    if (typeof item.id === 'string' && typeof label === 'string' && label !== '') {
      map.set(item.id, label);
    }
  }
  return map;
}
