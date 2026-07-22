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
 * Painting a run onto the canvas: map an execution's log lines to
 * per-node states, loop badges and the degraded set. Shared by the
 * builder's live Run poll and the ?run= replay view.
 */
import type { RunLog } from '../api.js';

export type NodeRunStatus = 'running' | 'completed' | 'failed' | 'orphaned';

/** Map one execution log entry to a node run state (last entry per node wins). */
function statusFromLog(log: RunLog): NodeRunStatus | undefined {
  const event = log.event ?? '';
  if (log.outcome === 'failed' || event.endsWith('failed')) return 'failed';
  if (log.outcome === 'completed' || event.endsWith('completed')) return 'completed';
  if (event.endsWith('started')) return 'running';
  return undefined;
}

/** A whole run's logs -> per-node states + loop iteration badges + the steps
 *  that degraded to this computer. Orphaned rows carry a nodeIds ARRAY (the
 *  losing branch is marked as a set). */
export function statesFromLogs(logs: RunLog[]): {
  states: Record<string, NodeRunStatus>;
  badges: Record<string, string>;
  degraded: Record<string, boolean>;
} {
  const states: Record<string, NodeRunStatus> = {};
  const badges: Record<string, string> = {};
  const degraded: Record<string, boolean> = {};
  for (const log of logs) {
    const event = log.event ?? '';
    if (event.endsWith('orphaned')) {
      for (const nodeId of (log as { nodeIds?: string[] }).nodeIds ?? []) {
        states[nodeId] = 'orphaned';
      }
      continue;
    }
    if (!log.nodeId) continue;
    const status = statusFromLog(log);
    if (status) states[log.nodeId] = status;
    if (log.binding === 'local-degraded') degraded[log.nodeId] = true;
    const iterations = (log.output as { iterations?: number } | undefined)?.iterations;
    if (event.endsWith('completed') && typeof iterations === 'number') {
      badges[log.nodeId] = `x${iterations}`;
    }
  }
  return { states, badges, degraded };
}
