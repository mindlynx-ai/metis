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
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataGateway } from '../gateway.js';
import { SqliteAdapter } from '../sqlite-adapter.js';
import { WorkflowStore, registerWorkflowTables } from '../workflow-store.js';

describe('WorkflowStore: the workflow method set over SQLite', () => {
  let store: WorkflowStore;
  let now: number;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-wfstore-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'store.db')));
    registerWorkflowTables(gateway);
    now = Date.parse('2026-07-03T12:00:00.000Z');
    store = new WorkflowStore(gateway, { clock: () => now });
  });

  const version = (n: number, changeset = 0, extra: Record<string, unknown> = {}) => ({
    tenantId: 't1',
    workflowId: 'wf1',
    version: n,
    changeset,
    status: 'draft',
    name: `workflow v${n}`,
    type: 'workflow',
    definition: { nodes: [{ id: 'n1' }], edges: [] },
    ...extra,
  });

  it('round-trips a workflow version with definition, version and changeset preserved', async () => {
    await store.putWorkflowVersion(version(1, 2));
    const item = await store.getWorkflowVersion('t1', 'wf1', 1, 2);
    expect(item?.definition).toEqual({ nodes: [{ id: 'n1' }], edges: [] });
    expect(item?.version).toBe(1);
    expect(item?.changeset).toBe(2);
    expect(await store.getWorkflowVersion('t1', 'wf1', 9, 9)).toBeUndefined();
  });

  it('getLatestPublished returns the highest published version, numerically not lexically', async () => {
    await store.putWorkflowVersion(version(1, 0, { status: 'published' }));
    await store.putWorkflowVersion(version(2, 0, { status: 'published' }));
    for (let n = 3; n <= 11; n += 1) await store.putWorkflowVersion(version(n));
    const published = await store.getLatestPublished('t1', 'wf1');
    expect(published?.version).toBe(2);

    await store.putWorkflowVersion(version(10, 0, { status: 'published' }));
    expect((await store.getLatestPublished('t1', 'wf1'))?.version).toBe(10);
  });

  it('listWorkflows lists one row per workflow, newest update first, tenant-scoped', async () => {
    await store.putWorkflowVersion(version(1));
    now += 1000;
    await store.putWorkflowVersion(version(2));
    now += 1000;
    await store.putWorkflowVersion({ ...version(1), workflowId: 'wf2', name: 'other' });
    now += 1000;
    await store.putWorkflowVersion({ ...version(1), tenantId: 't2', workflowId: 'foreign' });

    const page = await store.listWorkflows('t1', { limit: 10 });
    expect(page.items.map((i) => i.workflowId)).toEqual(['wf2', 'wf1']);
    expect(page.items[1]?.version).toBe(2);
  });

  it('listWorkflows filters by status and paginates with a cursor', async () => {
    for (const id of ['a', 'b', 'c']) {
      await store.putWorkflowVersion({ ...version(1), workflowId: id, status: 'published' });
      now += 1000;
    }
    await store.putWorkflowVersion({ ...version(1), workflowId: 'd', status: 'draft' });
    const first = await store.listWorkflows('t1', { status: 'published', limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.cursor).toBeDefined();
    const rest = await store.listWorkflows('t1', {
      status: 'published',
      limit: 2,
      cursor: first.cursor,
    });
    expect(rest.items).toHaveLength(1);
    expect(rest.cursor).toBeUndefined();
  });

  it('softDeleteWorkflow unlists the workflow but keeps versions readable', async () => {
    await store.putWorkflowVersion(version(1));
    await store.softDeleteWorkflow('t1', 'wf1');
    const page = await store.listWorkflows('t1', { limit: 10 });
    expect(page.items).toEqual([]);
    const direct = await store.getWorkflowVersion('t1', 'wf1', 1, 0);
    expect(direct?.deleted).toBe(true);
  });

  it('writes, patches and reads execution META with LOG assembly in order', async () => {
    await store.writeExecutionMeta({
      tenantId: 't1',
      executionId: 'e1',
      workflowId: 'wf1',
      status: 'running',
      startTime: '2026-07-03T12:00:00.000Z',
    });
    await store.appendExecutionLog({
      tenantId: 't1',
      executionId: 'e1',
      sequence: 2,
      nodeId: 'n2',
      event: 'workflow.node.started',
    });
    await store.appendExecutionLog({
      tenantId: 't1',
      executionId: 'e1',
      sequence: 1,
      nodeId: 'n1',
      event: 'workflow.node.completed',
    });
    await store.updateExecutionMeta('t1', 'e1', { status: 'completed' });

    const execution = await store.getExecution('t1', 'e1');
    expect(execution?.meta.status).toBe('completed');
    expect(execution?.logs.map((l) => l.nodeId)).toEqual(['n1', 'n2']);
    expect(await store.getExecution('t1', 'missing')).toBeUndefined();
  });

  it('stamps a 90-day TTL on execution rows', async () => {
    await store.writeExecutionMeta({
      tenantId: 't1',
      executionId: 'e1',
      workflowId: 'wf1',
      status: 'running',
      startTime: '2026-07-03T12:00:00.000Z',
    });
    const execution = await store.getExecution('t1', 'e1');
    const expected = Math.floor(now / 1000) + 90 * 24 * 60 * 60;
    expect(execution?.meta.ttl).toBe(expected);
  });

  it('listExecutions filters by workflow and by status, newest first, with cursors', async () => {
    const start = (id: string, workflowId: string, status: string, offsetSeconds: number) =>
      store.writeExecutionMeta({
        tenantId: 't1',
        executionId: id,
        workflowId,
        status,
        startTime: new Date(now + offsetSeconds * 1000).toISOString(),
      });
    await start('e1', 'wf1', 'completed', 0);
    await start('e2', 'wf1', 'running', 10);
    await start('e3', 'wf2', 'running', 20);

    const all = await store.listExecutions('t1', { limit: 10 });
    expect(all.items.map((i) => i.executionId)).toEqual(['e3', 'e2', 'e1']);

    const byWorkflow = await store.listExecutions('t1', { workflowId: 'wf1', limit: 10 });
    expect(byWorkflow.items.map((i) => i.executionId)).toEqual(['e2', 'e1']);

    const byStatus = await store.listExecutions('t1', { status: 'running', limit: 10 });
    expect(byStatus.items.map((i) => i.executionId)).toEqual(['e3', 'e2']);

    const first = await store.listExecutions('t1', { limit: 2 });
    expect(first.cursor).toBeDefined();
    const rest = await store.listExecutions('t1', { limit: 2, cursor: first.cursor });
    expect(rest.items.map((i) => i.executionId)).toEqual(['e1']);
  });

  it('status changes keep listExecutions status filtering consistent', async () => {
    await store.writeExecutionMeta({
      tenantId: 't1',
      executionId: 'e1',
      workflowId: 'wf1',
      status: 'running',
      startTime: '2026-07-03T12:00:00.000Z',
    });
    await store.updateExecutionMeta('t1', 'e1', { status: 'completed' });
    expect((await store.listExecutions('t1', { status: 'running', limit: 10 })).items).toEqual([]);
    expect(
      (await store.listExecutions('t1', { status: 'completed', limit: 10 })).items.map(
        (i) => i.executionId,
      ),
    ).toEqual(['e1']);
  });
});
