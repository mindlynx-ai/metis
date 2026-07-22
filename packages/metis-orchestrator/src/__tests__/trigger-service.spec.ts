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
import { DataGateway, MemoryAdapter } from '@mindlynx/metis-data-gateway';
import { TriggerService, registerTriggerTable } from '../triggers.js';

function service(tenantId = 't1') {
  const gateway = new DataGateway(new MemoryAdapter());
  registerTriggerTable(gateway);
  return new TriggerService(gateway, tenantId);
}

describe('TriggerService', () => {
  it('creates and reads webhook, poll and schedule triggers', async () => {
    const svc = service();
    const hook = await svc.create({ kind: 'webhook', workflowId: 'wf', connectorId: 'github', event: 'push', verification: 'github', secret: 's' });
    expect(hook.triggerId).toMatch(/^trg_/);
    expect(hook.enabled).toBe(true);
    const back = await svc.get(hook.triggerId);
    expect(back?.verification).toBe('github');
    expect(back?.tenantId).toBe('t1');
  });

  it('lists by kind', async () => {
    const svc = service();
    await svc.create({ kind: 'webhook', workflowId: 'a' });
    await svc.create({ kind: 'poll', workflowId: 'b', connectorId: 'hubspot', cursorField: 'createdAt' });
    await svc.create({ kind: 'schedule', workflowId: 'c', cron: '0 * * * *' });
    expect((await svc.listByKind('poll')).map((t) => t.workflowId)).toEqual(['b']);
    expect(await svc.list()).toHaveLength(3);
  });

  it('advances the poll cursor and toggles enabled', async () => {
    const svc = service();
    const trg = await svc.create({ kind: 'poll', workflowId: 'b', cursorField: 'id' });
    await svc.setCursor(trg.triggerId, '100');
    await svc.setEnabled(trg.triggerId, false);
    const back = await svc.get(trg.triggerId);
    expect(back?.cursor).toBe('100');
    expect(back?.enabled).toBe(false);
  });

  it('honours an explicit triggerId and isolates tenants', async () => {
    const svc = service('t1');
    await svc.create({ kind: 'webhook', workflowId: 'a', triggerId: 'fixed' });
    expect((await svc.get('fixed'))?.workflowId).toBe('a');
    const other = service('t2');
    expect(await other.get('fixed')).toBeUndefined();
  });

  it('removes a trigger', async () => {
    const svc = service();
    const trg = await svc.create({ kind: 'webhook', workflowId: 'a' });
    await svc.remove(trg.triggerId);
    expect(await svc.get(trg.triggerId)).toBeUndefined();
  });
});
