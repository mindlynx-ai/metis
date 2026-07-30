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
 * The levers that start and stop a published workflow firing: arming a trigger,
 * changing its lock, pausing its schedule, deleting it. None of them touches the
 * definition, so the workflow's own history shows nothing, and a deleted trigger
 * leaves no row behind. The audit trail is the only place "why did the nightly
 * run stop" - or start - has an answer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { SingleTenantIdentity } from '@mindlynx/metis-ports';
import {
  AuditStore,
  DataGateway,
  SqliteAdapter,
  registerAuditTable,
} from '@mindlynx/metis-data-gateway';
import { buildCoreServer } from '../server.js';
import type { SchedulesLike } from '../schedule-routes.js';
import type { TriggersPort } from '../trigger-mgmt-routes.js';

describe('the levers that silence a workflow are on the trail', () => {
  let app: FastifyInstance;
  let audit: AuditStore;
  let adminToken: string;
  const removed: string[] = [];
  const created: Record<string, unknown>[] = [];
  const rotated: { triggerId: string; secret: string }[] = [];

  const schedules: SchedulesLike = {
    describeAll: () => Promise.resolve([]),
    pause: () => Promise.resolve(),
    unpause: () => Promise.resolve(),
  };
  const triggers: TriggersPort = {
    list: () => Promise.resolve([]),
    create: (input) => {
      created.push(input);
      return Promise.resolve({ triggerId: 'trg-1', ...input });
    },
    remove: (triggerId) => {
      removed.push(triggerId);
      return Promise.resolve();
    },
    setSecret: (triggerId, secret) => {
      rotated.push({ triggerId, secret });
      // The unknown trigger the 404 case needs; everything else rotates.
      return Promise.resolve(triggerId !== 'trg-gone');
    },
  };

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-operate-audit-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'operate.db')));
    registerAuditTable(gateway);
    audit = new AuditStore(gateway);
    const identity = await SingleTenantIdentity.create('t1', [
      { userId: 'jeremy', secret: 'pw', role: 'admin' },
    ]);
    app = buildCoreServer({ identity, audit, schedules, triggers });
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { userId: 'jeremy', secret: 'pw' },
    });
    adminToken = (login.json() as { token: string }).token;
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${adminToken}` } });

  const trailOf = async (entityId: string) =>
    (await audit.list('t1', { entityId })).map((entry) => ({
      action: entry.action,
      actor: entry.actor,
      entityType: entry.entityType,
    }));

  it('records who paused a schedule, against its workflow', async () => {
    expect((await call('POST', '/api/schedules/wf-paused/pause')).statusCode).toBe(202);
    expect(await trailOf('wf-paused')).toEqual([
      { action: 'schedule.paused', actor: 'jeremy', entityType: 'schedule' },
    ]);
  });

  it('records who started it again', async () => {
    expect((await call('POST', '/api/schedules/wf-resumed/unpause')).statusCode).toBe(202);
    expect(await trailOf('wf-resumed')).toEqual([
      { action: 'schedule.unpaused', actor: 'jeremy', entityType: 'schedule' },
    ]);
  });

  it('records who deleted a trigger, which is the only trace it leaves', async () => {
    expect((await call('DELETE', '/api/triggers/trg-9')).statusCode).toBe(204);
    expect(removed).toContain('trg-9');
    expect(await trailOf('trg-9')).toEqual([
      { action: 'trigger.deleted', actor: 'jeremy', entityType: 'trigger' },
    ]);
  });

  it('records who armed one, naming the workflow it now fires', async () => {
    const response = await call('POST', '/api/triggers', {
      workflowId: 'wf-nightly',
      kind: 'schedule',
      cron: '0 2 * * *',
    });
    expect(response.statusCode).toBe(201);
    expect(created).toContainEqual(expect.objectContaining({ workflowId: 'wf-nightly' }));
    const entries = await audit.list('t1', { entityId: 'trg-1' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'trigger.created',
      actor: 'jeremy',
      entityType: 'trigger',
      detail: { workflowId: 'wf-nightly', kind: 'schedule' },
    });
  });

  it('records who changed a webhook lock, and nothing at all about the lock', async () => {
    const secret = 'whsec-should-never-be-logged';
    const response = await call('PUT', '/api/triggers/trg-lock/secret', { secret });
    expect(response.statusCode).toBe(200);
    expect(rotated).toContainEqual({ triggerId: 'trg-lock', secret });
    const entries = await audit.list('t1', { entityId: 'trg-lock' });
    expect(entries.map((entry) => entry.action)).toEqual(['trigger.secretRotated']);
    expect(entries[0].actor).toBe('jeremy');
    // The point of the route is to replace a leaked secret, so the entry must
    // not carry it, its length or a prefix of it. Nothing narrows it here.
    expect(JSON.stringify(entries[0])).not.toContain('whsec');
    expect(entries[0].detail).toBeUndefined();
  });

  it('records nothing when there was no trigger to rotate', async () => {
    expect((await call('PUT', '/api/triggers/trg-gone/secret', { secret: 'x' })).statusCode).toBe(404);
    expect(await trailOf('trg-gone')).toEqual([]);
  });
});
