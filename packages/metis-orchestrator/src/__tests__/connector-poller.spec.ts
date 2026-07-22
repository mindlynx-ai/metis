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
import type { ExecutionPort, StartExecutionRequest } from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { TriggerService, registerTriggerTable, type TriggerRecord } from '../triggers.js';
import { ConnectorPoller, type FetchItems } from '../connector-poller.js';

class FakeExecutions implements ExecutionPort {
  started: (StartExecutionRequest & Record<string, unknown>)[] = [];
  async start(request: StartExecutionRequest & Record<string, unknown>) {
    this.started.push(request);
    return { executionId: request.executionId };
  }
  async signal() {}
  async cancel() {}
  async queryStatus() {
    return 'running' as const;
  }
  async describe() {
    return {};
  }
}

describe('ConnectorPoller (poll-bridge)', () => {
  let store: WorkflowStore;
  let triggers: TriggerService;
  let executions: FakeExecutions;
  let seq: number;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-poll-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'poll.db')));
    registerWorkflowTables(gateway);
    registerTriggerTable(gateway);
    store = new WorkflowStore(gateway);
    triggers = new TriggerService(gateway, 't1');
    executions = new FakeExecutions();
    seq = 0;
    await store.putWorkflowVersion({
      tenantId: 't1',
      workflowId: 'wf',
      version: 1,
      changeset: 0,
      status: 'published',
      name: 'wf',
      type: 'workflow',
      definition: { nodes: [{ id: 'n', type: 'code', config: { code: 'return {}' } }], edges: [] },
    });
  });

  const poller = (fetchItems: FetchItems) =>
    new ConnectorPoller({
      triggers,
      store,
      executions,
      tenantId: 't1',
      fetchItems,
      newExecutionId: () => `exec_${seq++}`,
    });

  const pollTrigger = (over: Partial<TriggerRecord> = {}) =>
    triggers.create({ kind: 'poll', workflowId: 'wf', connectorId: 'hubspot', event: 'newContact', cursorField: 'createdAt', ...over });

  it('seeds the cursor on the first run and fires nothing', async () => {
    const trg = await pollTrigger();
    const outcome = await poller(async () => [{ createdAt: '2026-01-01' }, { createdAt: '2026-03-01' }]).pollOnce(trg);
    expect(outcome.seeded).toBe(true);
    expect(outcome.started).toBe(0);
    expect(outcome.cursor).toBe('2026-03-01');
    expect((await triggers.get(trg.triggerId))?.cursor).toBe('2026-03-01');
  });

  it('fires only for items past the cursor, in order, and advances it', async () => {
    const trg = await pollTrigger();
    await triggers.setCursor(trg.triggerId, '2026-03-01');
    const fresh = await triggers.get(trg.triggerId);
    const outcome = await poller(async () => [
      { id: 'a', createdAt: '2026-02-01' },
      { id: 'c', createdAt: '2026-05-01' },
      { id: 'b', createdAt: '2026-04-01' },
    ]).pollOnce(fresh as TriggerRecord);
    expect(outcome.started).toBe(2);
    expect(outcome.cursor).toBe('2026-05-01');
    // started in ascending cursor order: 2026-04-01 then 2026-05-01
    expect((executions.started[0].input as { item: { id: string } }).item.id).toBe('b');
    expect((executions.started[1].input as { item: { id: string } }).item.id).toBe('c');
    expect((await triggers.get(trg.triggerId))?.cursor).toBe('2026-05-01');
  });

  it('compares numeric cursors numerically (9 < 10)', async () => {
    const trg = await pollTrigger({ cursorField: 'id' });
    await triggers.setCursor(trg.triggerId, '9');
    const fresh = await triggers.get(trg.triggerId);
    const outcome = await poller(async () => [{ id: 9 }, { id: 10 }, { id: 8 }]).pollOnce(fresh as TriggerRecord);
    expect(outcome.started).toBe(1);
    expect(outcome.cursor).toBe('10');
  });

  it('reports no published version without starting anything', async () => {
    const trg = await pollTrigger({ workflowId: 'missing' });
    await triggers.setCursor(trg.triggerId, '2026-01-01');
    const fresh = await triggers.get(trg.triggerId);
    const outcome = await poller(async () => [{ createdAt: '2026-09-01' }]).pollOnce(fresh as TriggerRecord);
    expect(outcome.started).toBe(0);
    expect(outcome.error).toMatch(/no published version/);
    expect(executions.started).toHaveLength(0);
  });

  it('tick() polls every enabled poll trigger and skips disabled ones', async () => {
    const a = await pollTrigger();
    await triggers.setCursor(a.triggerId, '2026-01-01');
    const b = await pollTrigger();
    await triggers.setEnabled(b.triggerId, false);
    const outcomes = await poller(async () => [{ createdAt: '2026-09-01' }]).tick();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].triggerId).toBe(a.triggerId);
    expect(outcomes[0].started).toBe(1);
  });
});
