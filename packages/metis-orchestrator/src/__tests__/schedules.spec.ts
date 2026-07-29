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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@temporalio/client';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { ScheduleService } from '../schedules.js';

interface CapturedAction {
  workflowId: string;
  args: { executionId: string }[];
}

const buildService = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'metis-sched-'));
  const gateway = new DataGateway(new SqliteAdapter(join(dir, 'sched.db')));
  registerWorkflowTables(gateway);
  const store = new WorkflowStore(gateway);
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
  const created: { scheduleId: string; action: CapturedAction }[] = [];
  const client = {
    schedule: {
      create: async (options: { scheduleId: string; action: CapturedAction }) => {
        created.push(options);
      },
    },
  } as unknown as Client;
  return { service: new ScheduleService(store, { client }), created };
};

describe('ScheduleService action identity', () => {
  it('registers the schedule id as the workflow-id base every fire is named from', async () => {
    const { service, created } = await buildService();
    const { scheduleId } = await service.create('t1', 'wf', '* * * * *');

    expect(scheduleId).toBe('sch_t1_wf');
    // Temporal appends the nominal fire time to this base, and helixWorkflow
    // records under the id it is handed - so the base is what makes a run
    // traceable to the schedule that produced it. Randomise it and Operate can
    // no longer say which schedule a run came from.
    expect(created[0].action.workflowId).toBe('exec_sch_t1_wf');
  });

  it('never pretends the action itself carries a per-fire identity', async () => {
    const { service, created } = await buildService();
    await service.create('t1', 'wf', '* * * * *');
    await service.create('t1', 'wf', '0 3 * * *');

    // The whole trap in one assertion: an action is written once and replayed,
    // so its executionId is a constant. Anything downstream that treats it as
    // the run's id gives a schedule ONE record, overwritten at every tick.
    const ids = created.map((entry) => entry.action.args[0].executionId);
    expect(new Set(ids).size).toBe(1);
  });
});
