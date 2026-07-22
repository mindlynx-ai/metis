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
import { computeOverview } from '../overview-stats.js';
import type { ExecutionSummary, WorkflowItem, ConnectionRecord } from '../api.js';

const wf = (id: string, name: string, status: string): WorkflowItem =>
  ({ id, name, status, type: 'workflow', version: 1, changeset: 1, nodes: [], edges: [] }) as WorkflowItem;
const exec = (workflowId: string, status: string, startTime: string): ExecutionSummary => ({
  executionId: `${workflowId}-${startTime}`,
  workflowId,
  status,
  startTime,
});
const conn = (id: string): ConnectionRecord => ({ connectionId: id, name: id, connectorId: 'x' });

const NOW = '2026-07-07T12:00:00.000Z';

describe('computeOverview', () => {
  const workflows = [wf('wf-a', 'Alpha', 'published'), wf('wf-b', 'Beta', 'published'), wf('wf-c', 'Gamma', 'draft')];
  const executions = [
    exec('wf-a', 'completed', '2026-07-07T09:00:00.000Z'),
    exec('wf-a', 'completed', '2026-07-06T09:00:00.000Z'),
    exec('wf-a', 'failed', '2026-07-07T10:00:00.000Z'),
    exec('wf-b', 'completed', '2026-07-05T09:00:00.000Z'),
    exec('wf-b', 'running', '2026-07-07T11:59:00.000Z'),
  ];
  const connections = [conn('c1'), conn('c2')];

  const overview = computeOverview({ workflows, executions, connections, now: NOW });

  it('counts active (published) workflows out of the total', () => {
    expect(overview.activeWorkflows).toBe(2);
    expect(overview.totalWorkflows).toBe(3);
  });

  it('summarises runs and the success rate over finished runs only', () => {
    expect(overview.totalRuns).toBe(5);
    expect(overview.completedRuns).toBe(3);
    expect(overview.failedRuns).toBe(1);
    // 3 of 4 finished runs succeeded (the running one is excluded).
    expect(overview.successRate).toBe(75);
  });

  it('counts connected tools', () => {
    expect(overview.connectedTools).toBe(2);
  });

  it('lists the busiest workflows by run count, names resolved', () => {
    expect(overview.busiest[0]).toMatchObject({ name: 'Alpha', runs: 3 });
    expect(overview.busiest[1]).toMatchObject({ name: 'Beta', runs: 2 });
  });

  it('surfaces failed runs as needs-attention, newest first', () => {
    expect(overview.needsAttention).toHaveLength(1);
    expect(overview.needsAttention[0]).toMatchObject({ name: 'Alpha', status: 'failed' });
  });

  it('lists recent runs newest first with names resolved', () => {
    expect(overview.recent[0]).toMatchObject({ name: 'Beta', status: 'running' });
    expect(overview.recent.map((r) => r.name)).toEqual(['Beta', 'Alpha', 'Alpha', 'Alpha', 'Beta']);
  });

  it('buckets runs into 14 daily activity bars ending today', () => {
    expect(overview.activity).toHaveLength(14);
    // The last bar is today (2 runs), the previous day is 1.
    expect(overview.activity[13]).toBe(3);
    expect(overview.activity[12]).toBe(1);
  });

  it('handles an empty account without dividing by zero', () => {
    const empty = computeOverview({ workflows: [], executions: [], connections: [], now: NOW });
    expect(empty.totalRuns).toBe(0);
    expect(empty.successRate).toBe(100);
    expect(empty.busiest).toEqual([]);
    expect(empty.activity).toHaveLength(14);
  });
});
