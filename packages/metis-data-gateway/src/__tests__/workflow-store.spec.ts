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
import { ConditionFailedError } from '@mindlynx/metis-ports';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataGateway } from '../gateway.js';
import { SqliteAdapter } from '../sqlite-adapter.js';
import { WorkflowStore, registerWorkflowTables, WORKFLOWS_TABLE } from '../workflow-store.js';

describe('WorkflowStore: the workflow method set over SQLite', () => {
  let store: WorkflowStore;
  let gateway: DataGateway;
  let now: number;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-wfstore-'));
    gateway = new DataGateway(new SqliteAdapter(join(dir, 'store.db')));
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

  it('mustBeNew refuses to write over a changeset another editor already saved', async () => {
    await store.putWorkflowVersion(version(1, 0));
    // Both editors read changeset 0 and both mint 1.
    await store.putWorkflowVersion(version(1, 1, { name: 'first editor' }), { mustBeNew: true });
    await expect(
      store.putWorkflowVersion(version(1, 1, { name: 'second editor' }), { mustBeNew: true }),
    ).rejects.toThrow(ConditionFailedError);
    expect((await store.getWorkflowVersion('t1', 'wf1', 1, 1))?.name).toBe('first editor');
  });

  it('publish still rewrites the row it read (mustBeNew is opt-in)', async () => {
    await store.putWorkflowVersion(version(1, 0));
    await store.putWorkflowVersion(version(1, 0, { status: 'published' }));
    expect((await store.getWorkflowVersion('t1', 'wf1', 1, 0))?.status).toBe('published');
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

  it('a deleted workflow refuses further versions rather than coming back', async () => {
    await store.putWorkflowVersion(version(1));
    await store.softDeleteWorkflow('t1', 'wf1');
    now += 1000;
    await expect(store.putWorkflowVersion(version(1, 1))).rejects.toBeInstanceOf(
      ConditionFailedError,
    );
    await expect(
      store.putWorkflowVersion(version(1, 1), { mustBeNew: true }),
    ).rejects.toBeInstanceOf(ConditionFailedError);
    expect(await store.getWorkflowVersion('t1', 'wf1', 1, 1)).toBeUndefined();
    expect((await store.listWorkflows('t1', { limit: 10 })).items).toEqual([]);
  });

  it('listWorkflows drops a deleted row even when it carries index keys', async () => {
    await store.putWorkflowVersion(version(1));
    await store.putWorkflowVersion({ ...version(1), workflowId: 'wf2' });
    // What the old resurrection left behind: deleted true with the listing
    // keys set. Written through the gateway because the store now refuses it.
    await gateway.update(
      WORKFLOWS_TABLE.name,
      { partitionKey: 'WF#t1#wf1', sortKey: 'VER#000001#000000' },
      { deleted: true },
    );
    const page = await store.listWorkflows('t1', { limit: 10 });
    expect(page.items.map((i) => i.workflowId)).toEqual(['wf2']);
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

  // The 90-day TTL stamp this used to assert is gone: no adapter ever read it
  // (see "no longer stamps a ttl nothing can read"). Expiry is pruneExecutions.

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

/**
 * Pruning execution history. This code DELETES a user's run history, so the two
 * rules that matter most - it does nothing unless the operator asked, and it
 * never touches a run that is still going - are asserted from several angles
 * rather than once.
 */
describe('WorkflowStore: pruning execution history', () => {
  const DAY = 24 * 60 * 60 * 1000;
  let gateway: DataGateway;
  let now: number;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-prune-'));
    gateway = new DataGateway(new SqliteAdapter(join(dir, 'store.db')));
    registerWorkflowTables(gateway);
    now = Date.parse('2026-08-06T12:00:00.000Z');
  });

  const storeWith = (retentionDays?: number) =>
    new WorkflowStore(gateway, { clock: () => now, retentionDays });

  /** A run, aged in days, with two log rows so META and LOG are both covered. */
  async function seed(
    store: WorkflowStore,
    executionId: string,
    ageDays: number,
    status: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const startTime = new Date(now - ageDays * DAY).toISOString();
    await store.writeExecutionMeta({
      tenantId: 't1',
      executionId,
      workflowId: 'wf1',
      status,
      startTime,
      ...extra,
    });
    for (const sequence of [1, 2]) {
      await store.appendExecutionLog({ tenantId: 't1', executionId, sequence });
    }
  }

  const survives = async (store: WorkflowStore, executionId: string) =>
    (await store.getExecution('t1', executionId)) !== undefined;

  it('deletes nothing at all when no retention is configured', async () => {
    const store = storeWith(undefined);
    await seed(store, 'ancient', 400, 'completed');
    await seed(store, 'old', 91, 'failed');

    expect(await store.pruneExecutions('t1')).toEqual({ executions: 0, rows: 0, kept: 0 });
    expect(await survives(store, 'ancient')).toBe(true);
    expect(await survives(store, 'old')).toBe(true);
    expect(store.retentionDays).toBeUndefined();
  });

  it('deletes a closed run past the window, its LOG rows with it', async () => {
    const store = storeWith(30);
    await seed(store, 'stale', 60, 'completed');

    expect(await store.pruneExecutions('t1')).toEqual({ executions: 1, rows: 3, kept: 0 });
    expect(await survives(store, 'stale')).toBe(false);
    const leftovers = await gateway.query({
      table: 'workflow_executions',
      partitionValue: 'EXEC#t1#stale',
      limit: 50,
    });
    expect(leftovers.items).toEqual([]);
  });

  it('keeps a run that is still going, however old it is', async () => {
    const store = storeWith(1);
    // Parked on a signal since April. Old is not the same as abandoned.
    await seed(store, 'parked', 120, 'running');

    expect(await store.pruneExecutions('t1')).toEqual({ executions: 0, rows: 0, kept: 1 });
    expect(await survives(store, 'parked')).toBe(true);
  });

  it('treats a status it does not recognise as still going', async () => {
    const store = storeWith(1);
    // A later version inventing 'paused' must not make this a delete list.
    await seed(store, 'paused', 120, 'paused');

    expect((await store.pruneExecutions('t1')).executions).toBe(0);
    expect(await survives(store, 'paused')).toBe(true);
  });

  it('a dry run reports exactly what would go and deletes none of it', async () => {
    const store = storeWith(30);
    await seed(store, 'stale', 60, 'completed');
    await seed(store, 'parked', 60, 'running');

    expect(await store.pruneExecutions('t1', { dryRun: true })).toEqual({
      executions: 1,
      rows: 3,
      kept: 1,
    });
    expect(await survives(store, 'stale')).toBe(true);
    expect(await survives(store, 'parked')).toBe(true);
  });

  it('keeps a closed run that is still inside the window', async () => {
    const store = storeWith(30);
    await seed(store, 'recent', 3, 'completed');

    expect((await store.pruneExecutions('t1')).executions).toBe(0);
    expect(await survives(store, 'recent')).toBe(true);
  });

  it('ages a run by when it ended, not by when it started', async () => {
    const store = storeWith(30);
    // Started 90 days ago, finished yesterday: 29 days of archive still owed.
    await seed(store, 'long', 90, 'completed', {
      endTime: new Date(now - 1 * DAY).toISOString(),
    });

    expect((await store.pruneExecutions('t1')).executions).toBe(0);
    expect(await survives(store, 'long')).toBe(true);
  });

  it('takes an explicit window even when the config sets none', async () => {
    const store = storeWith(undefined);
    await seed(store, 'stale', 60, 'completed');

    expect((await store.pruneExecutions('t1', { olderThanDays: 30 })).executions).toBe(1);
    expect(await survives(store, 'stale')).toBe(false);
  });

  it('leaves another tenant alone', async () => {
    const store = storeWith(30);
    await seed(store, 'stale', 60, 'completed');
    await store.writeExecutionMeta({
      tenantId: 't2',
      executionId: 'theirs',
      workflowId: 'wf1',
      status: 'completed',
      startTime: new Date(now - 60 * DAY).toISOString(),
    });

    await store.pruneExecutions('t1');
    expect(await store.getExecution('t2', 'theirs')).toBeDefined();
  });

  it('two prunes at once neither double-count nor corrupt the store', async () => {
    const store = storeWith(30);
    for (const id of ['a', 'b', 'c']) await seed(store, id, 60, 'completed');
    await seed(store, 'keep', 60, 'running');

    const [first, second] = await Promise.all([
      store.pruneExecutions('t1'),
      store.pruneExecutions('t1'),
    ]);
    expect(first.executions + second.executions).toBeGreaterThanOrEqual(3);
    for (const id of ['a', 'b', 'c']) expect(await survives(store, id)).toBe(false);
    expect(await survives(store, 'keep')).toBe(true);
    expect(await store.pruneExecutions('t1')).toEqual({ executions: 0, rows: 0, kept: 1 });
  });

  it('no longer stamps a ttl nothing can read', async () => {
    const store = storeWith(30);
    await seed(store, 'e1', 1, 'running');
    const execution = await store.getExecution('t1', 'e1');
    expect(execution?.meta).not.toHaveProperty('ttl');
    expect(execution?.logs[0]).not.toHaveProperty('ttl');
  });
});
