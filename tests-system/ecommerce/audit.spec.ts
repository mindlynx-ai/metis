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
 * The audit trail: who did what. The e-commerce spec asks for one in eleven
 * separate acceptance criteria ("audit trail records approver identity,
 * decision, timestamp"), and the run log cannot answer it because it carries
 * no actor. These cases prove the question is now answerable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, client, login, runtimeUp } from '../harness.js';
import {
  awaitSignal,
  cancelRun,
  cancelStragglers,
  edge,
  nodeWaiting,
  sendSignal,
  settled,
  startRun,
  step,
  until,
  wait,
  type Api,
} from './shop.js';

interface AuditRecord {
  auditId: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  outcome?: string;
  at: string;
  detail?: Record<string, unknown>;
}

const up = await runtimeUp();
const suite = up ? describe : describe.skip;
if (!up) {
  // eslint-disable-next-line no-console
  console.warn(`[ecommerce] no runtime at ${BASE}; skipping. Start the stack or set METIS_URL.`);
}

suite('audit trail', () => {
  let api: Api;
  let wf: string;

  const auditFor = async (entityId: string): Promise<AuditRecord[]> => {
    const res = await api<{ items: AuditRecord[] }>(
      'GET',
      `/api/audit?entityId=${encodeURIComponent(entityId)}`,
    );
    return res.body.items ?? [];
  };

  beforeAll(async () => {
    api = client(await login());
    const created = await api<{ workflowId: string }>('POST', '/api/workflows', {
      name: `audit-${Date.now()}`,
      type: 'workflow',
      nodes: [step('return { seeded: true };', 'seed')],
      edges: [],
    });
    wf = created.body.workflowId;
  });

  afterAll(async () => {
    await cancelStragglers(api);
  });

  it('AUDIT-01 a cancelled run records who cancelled it and why', async () => {
    const start = step('return { order: "ord-audit-1" };', 'place order');
    const held = wait(30, 'long wait');
    const executionId = await startRun(api, wf, [start, held], [edge(start.id, held.id)]);
    await until(api, executionId, nodeWaiting(held.id), 30000);

    expect(await cancelRun(api, executionId, 'customer called to cancel')).toBe(202);
    await until(api, executionId, settled, 30000);

    const entries = await auditFor(executionId);
    const cancelled = entries.find((e) => e.action === 'execution.cancelled');
    expect(cancelled).toBeDefined();
    // The three things the run log could never tell you.
    expect(cancelled?.actor).toBe('admin');
    expect(cancelled?.entityType).toBe('execution');
    expect(cancelled?.detail?.reason).toBe('customer called to cancel');
    expect(Date.parse(cancelled?.at ?? '')).toBeGreaterThan(0);
  }, 90000);

  it('AUDIT-02 a signal records who sent it and which one', async () => {
    const start = step('return { rma: "RMA-audit" };', 'return requested');
    const parcel = awaitSignal('return.received', { label: 'await parcel' });
    const executionId = await startRun(api, wf, [start, parcel], [edge(start.id, parcel.id)]);
    await until(api, executionId, nodeWaiting(parcel.id), 30000);

    expect(await sendSignal(api, executionId, 'return.received', { at: 'depot' })).toBe(202);
    await until(api, executionId, settled, 30000);

    const signalled = (await auditFor(executionId)).find((e) => e.action === 'execution.signalled');
    expect(signalled?.actor).toBe('admin');
    expect(signalled?.detail?.signalType).toBe('return.received');
  }, 90000);

  it('AUDIT-03 the trail reads newest first and narrows by actor', async () => {
    const res = await api<{ items: AuditRecord[]; count: number }>('GET', '/api/audit?limit=20');
    const items = res.body.items ?? [];
    expect(items.length).toBeGreaterThan(0);
    // Newest first: the question is nearly always "what just happened".
    const times = items.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const mine = await api<{ items: AuditRecord[] }>('GET', '/api/audit?actor=admin');
    expect(mine.body.items.every((e) => e.actor === 'admin')).toBe(true);
    const nobody = await api<{ items: AuditRecord[] }>('GET', '/api/audit?actor=someone-else');
    expect(nobody.body.items).toHaveLength(0);
  }, 60000);

  it('AUDIT-04 publishing a workflow is recorded against the workflow', async () => {
    const trigger = {
      id: `node-${Date.now()}`,
      type: 'signal',
      version: 'v1',
      data: { label: 'start', config: { signalType: 'manual' } },
    };
    const created = await api<{ workflowId: string }>('POST', '/api/workflows', {
      name: `audit-publish-${Date.now()}`,
      type: 'workflow',
      nodes: [trigger],
      edges: [],
    });
    const id = created.body.workflowId;
    const published = await api('POST', `/api/workflows/${id}/publish`);
    expect(published.status).toBe(200);

    const entries = await auditFor(id);
    expect(entries.some((e) => e.action === 'workflow.created')).toBe(true);
    const publish = entries.find((e) => e.action === 'workflow.published');
    expect(publish?.actor).toBe('admin');
    expect(publish?.entityType).toBe('workflow');
  }, 60000);

  it('AUDIT-05 storing and deleting a credential is recorded, never its material', async () => {
    const secret = 'xoxb-should-never-be-logged';
    const conn = await api<{ connectionId: string }>('POST', '/api/connections', {
      name: 'Audit probe',
      connectorId: 'slack',
      connectionType: 'rest',
      authScheme: 'bearer',
      material: { token: secret },
    });
    expect(conn.status).toBe(201);
    const connectionId = conn.body.connectionId;

    const created = (await auditFor(connectionId)).find((e) => e.action === 'connection.created');
    expect(created?.actor).toBe('admin');
    expect(created?.detail?.connectorId).toBe('slack');
    // The whole point: the trail says a credential was stored, not what it was.
    expect(JSON.stringify(created)).not.toContain(secret);

    expect((await api('DELETE', `/api/connections/${connectionId}`)).status).toBe(204);
    const deleted = (await auditFor(connectionId)).find((e) => e.action === 'connection.deleted');
    expect(deleted?.actor).toBe('admin');
  }, 60000);

  it('AUDIT-06 a rejected sign-in is recorded as denied', async () => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'admin', secret: 'not-the-password' }),
    });
    expect(res.status).toBe(401);

    const denied = await api<{ items: AuditRecord[] }>('GET', '/api/audit?action=auth.login');
    const rejection = denied.body.items.find((e) => e.outcome === 'denied');
    expect(rejection).toBeDefined();
    expect(rejection?.entityType).toBe('user');
  }, 60000);
});
