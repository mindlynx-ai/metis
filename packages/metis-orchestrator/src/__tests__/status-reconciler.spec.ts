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
import { CapturingEventSink, type ExecutionPort, type ExecutionStatusValue } from '@mindlynx/metis-ports';
import { DataGateway, MemoryAdapter, WorkflowStore, registerWorkflowTables } from '@mindlynx/metis-data-gateway';
import { reconcileExecutionStatuses } from '../status-reconciler.js';

const TENANT = 't1';

function buildStore(): WorkflowStore {
  const gateway = new DataGateway(new MemoryAdapter());
  registerWorkflowTables(gateway);
  return new WorkflowStore(gateway);
}

function portAnswering(answers: Record<string, ExecutionStatusValue | Error>): ExecutionPort {
  return {
    start: () => Promise.reject(new Error('unused')),
    signal: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    describe: () => Promise.resolve({}),
    queryStatus: (executionId: string) => {
      const answer = answers[executionId];
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer ?? 'running');
    },
  };
}

describe('status reconciler (the stale-running-row fix)', () => {
  it('syncs rows Temporal says finished, emits the event, leaves live runs alone', async () => {
    const store = buildStore();
    const events = new CapturingEventSink();
    const meta = (executionId: string, status: string) =>
      store.writeExecutionMeta({
        tenantId: TENANT,
        executionId,
        workflowId: 'wf-1',
        status,
        startTime: '2026-07-10T10:00:00.000Z',
      });
    await meta('exec-terminated', 'running'); // killed via mission control
    await meta('exec-alive', 'running'); // genuinely still running
    await meta('exec-done', 'completed'); // already terminal: not checked

    const result = await reconcileExecutionStatuses({
      store,
      events,
      tenantId: TENANT,
      executions: portAnswering({ 'exec-terminated': 'terminated', 'exec-alive': 'running' }),
    });

    expect(result).toEqual({ checked: 2, fixed: 1 });
    const fixedRow = await store.getExecution(TENANT, 'exec-terminated');
    expect(fixedRow?.meta?.status).toBe('terminated');
    expect(String(fixedRow?.meta?.failureReason ?? '')).toMatch(/reconciled/);
    const aliveRow = await store.getExecution(TENANT, 'exec-alive');
    expect(aliveRow?.meta?.status).toBe('running');
    // The socket hub gets the event, so open UIs update live.
    const names = events.events.map((event) => event.name);
    expect(names).toContain('workflow.execution.failed');
  });

  it('a Temporal error leaves the row for the next pass (no false terminal)', async () => {
    const store = buildStore();
    await store.writeExecutionMeta({
      tenantId: TENANT,
      executionId: 'exec-unreachable',
      workflowId: 'wf-1',
      status: 'running',
      startTime: '2026-07-10T10:00:00.000Z',
    });
    const result = await reconcileExecutionStatuses({
      store,
      tenantId: TENANT,
      executions: portAnswering({ 'exec-unreachable': new Error('temporal down') }),
    });
    expect(result).toEqual({ checked: 1, fixed: 0 });
    expect((await store.getExecution(TENANT, 'exec-unreachable'))?.meta?.status).toBe('running');
  });
});
