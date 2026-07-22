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
 * The overview's numbers, derived entirely on the client from the workflow,
 * execution and connection lists the app already serves - no new backend. Pure
 * and `now`-injected so it is deterministic to test.
 */
import type { ConnectionRecord, ExecutionSummary, WorkflowItem } from './api.js';

const DAY_MS = 86_400_000;
const ACTIVITY_DAYS = 14;

export interface OverviewRun {
  executionId: string;
  name: string;
  status: string;
  startTime?: string;
}

export interface OverviewBusiest {
  workflowId: string;
  name: string;
  runs: number;
}

export interface Overview {
  activeWorkflows: number;
  totalWorkflows: number;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  successRate: number;
  connectedTools: number;
  activity: number[];
  busiest: OverviewBusiest[];
  needsAttention: OverviewRun[];
  recent: OverviewRun[];
}

/** UTC day number for an ISO timestamp (floor to midnight), NaN when absent. */
function dayOf(iso: string | undefined): number {
  if (!iso) return Number.NaN;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NaN : Math.floor(ms / DAY_MS);
}

export function computeOverview(input: {
  workflows: WorkflowItem[];
  executions: ExecutionSummary[];
  connections: ConnectionRecord[];
  now: string;
}): Overview {
  const { workflows, executions, connections, now } = input;
  const nameOf = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
  const label = (workflowId: string) => nameOf.get(workflowId) ?? workflowId;

  const completedRuns = executions.filter((run) => run.status === 'completed').length;
  const failedRuns = executions.filter((run) => run.status === 'failed').length;
  const finished = completedRuns + failedRuns;
  const successRate = finished === 0 ? 100 : Math.round((completedRuns / finished) * 100);

  const runsByWorkflow = new Map<string, number>();
  for (const run of executions) {
    runsByWorkflow.set(run.workflowId, (runsByWorkflow.get(run.workflowId) ?? 0) + 1);
  }
  const busiest = [...runsByWorkflow.entries()]
    .map(([workflowId, runs]) => ({ workflowId, name: label(workflowId), runs }))
    .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name))
    .slice(0, 5);

  const byNewest = [...executions].sort(
    (a, b) => Date.parse(b.startTime ?? '') - Date.parse(a.startTime ?? ''),
  );
  const toRun = (run: ExecutionSummary): OverviewRun => ({
    executionId: run.executionId,
    name: label(run.workflowId),
    status: run.status,
    startTime: run.startTime,
  });

  const today = dayOf(now);
  const activity = Array.from({ length: ACTIVITY_DAYS }, () => 0);
  for (const run of executions) {
    const index = ACTIVITY_DAYS - 1 - (today - dayOf(run.startTime));
    if (index >= 0 && index < ACTIVITY_DAYS) activity[index] += 1;
  }

  return {
    activeWorkflows: workflows.filter((workflow) => workflow.status === 'published').length,
    totalWorkflows: workflows.length,
    totalRuns: executions.length,
    completedRuns,
    failedRuns,
    successRate,
    connectedTools: connections.length,
    activity,
    busiest,
    needsAttention: byNewest.filter((run) => run.status === 'failed').slice(0, 3).map(toRun),
    recent: byNewest.slice(0, 5).map(toRun),
  };
}
