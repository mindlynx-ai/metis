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
  WorkflowStore,
  registerAuditTable,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { buildCoreServer } from '../server.js';

const SIG = 'node-e1aaaaaa-1111-4222-8333-444444444444';
const WORK = 'node-e2bbbbbb-1111-4222-8333-444444444444';

// Helix-exact node/edge shape: config under data.config, version, nullable
// sourceHandle.
const node = (id: string, type: string, config: Record<string, unknown>) => ({
  id,
  type,
  version: 'v1',
  data: { label: type, config },
});
const edge = (source: string, target: string) => ({
  id: `${source}->${target}`,
  source,
  target,
  sourceHandle: null,
});

describe('definition CRUD with publish validation', () => {
  let app: FastifyInstance;
  // A second tenant's server over the SAME store: the only way to prove the
  // routes are scoped by session tenant rather than by who holds the id.
  let otherApp: FastifyInstance;
  let store: WorkflowStore;
  let audit: AuditStore;
  let adminToken: string;
  let viewerToken: string;
  let otherToken: string;

  const bareDefinition = {
    nodes: [node(WORK, 'echo', { v: 1 })],
    edges: [] as ReturnType<typeof edge>[],
  };
  const triggeredDefinition = {
    nodes: [node(SIG, 'signal', { signalType: 'manual' }), node(WORK, 'echo', { v: 2 })],
    edges: [edge(SIG, WORK)],
  };

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-crud-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'crud.db')));
    registerWorkflowTables(gateway);
    registerAuditTable(gateway);
    store = new WorkflowStore(gateway);
    audit = new AuditStore(gateway);
    const identity = await SingleTenantIdentity.create('t1', [
      { userId: 'jeremy', secret: 'pw', role: 'admin' },
      { userId: 'watcher', secret: 'pw', role: 'viewer' },
    ]);
    app = buildCoreServer({ identity, store, audit });
    await app.ready();
    const login = async (instance: FastifyInstance, userId: string) => {
      const response = await instance.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { userId, secret: 'pw' },
      });
      return (response.json() as { token: string }).token;
    };
    adminToken = await login(app, 'jeremy');
    viewerToken = await login(app, 'watcher');

    const otherIdentity = await SingleTenantIdentity.create('t2', [
      { userId: 'mallory', secret: 'pw', role: 'admin' },
    ]);
    otherApp = buildCoreServer({ identity: otherIdentity, store, audit });
    await otherApp.ready();
    otherToken = await login(otherApp, 'mallory');
  });

  afterAll(async () => {
    await app?.close();
    await otherApp?.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    token = adminToken,
  ) =>
    app.inject({
      method,
      url,
      payload: body as Record<string, unknown> | undefined,
      headers: { authorization: `Bearer ${token}` },
    });

  const create = async (name: string, definition: typeof bareDefinition, token = adminToken) =>
    call('POST', '/api/workflows', { name, ...definition }, token);

  it('round-trips create, read, update and delete with version and changeset preserved', async () => {
    const created = await create('CRUD workflow', bareDefinition);
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };
    expect(id).toMatch(/^wf_/);
    expect(created.json()).toEqual({ id, workflowId: id, version: 1, changeset: 0 });

    const read = await call('GET', `/api/workflows/${id}`);
    const item = read.json() as { id: string; version: number; changeset: number; nodes: { data: { config: unknown } }[] };
    expect(item.id).toBe(id);
    expect(item.version).toBe(1);
    expect(item.changeset).toBe(0);
    expect(item.nodes).toHaveLength(1);
    expect(item.nodes[0]?.data.config).toEqual({ v: 1 });

    const updated = await call('PATCH', `/api/workflows/${id}`, {
      nodes: triggeredDefinition.nodes,
      edges: triggeredDefinition.edges,
    });
    expect(updated.json()).toEqual({ id, workflowId: id, version: 1, changeset: 1 });

    const original = await call('GET', `/api/workflows/${id}?version=1&changeset=0`);
    expect((original.json() as { nodes: { data: { config: unknown } }[] }).nodes[0]?.data.config).toEqual({ v: 1 });
    const latest = await call('GET', `/api/workflows/${id}`);
    expect((latest.json() as { changeset: number }).changeset).toBe(1);

    const removed = await call('DELETE', `/api/workflows/${id}`);
    expect(removed.statusCode).toBe(204);
    const listed = await call('GET', '/api/workflows?limit=10');
    expect((listed.json() as { items: unknown[] }).items).toEqual([]);
    const stillReadable = await call('GET', `/api/workflows/${id}`);
    expect((stillReadable.json() as { deleted: boolean }).deleted).toBe(true);
  });

  // Deletion is soft and delisting was done purely by nulling the index keys,
  // which every write sets again. An editor left open on a deleted workflow
  // could therefore save or publish it straight back into the list, and a
  // delete a user can undo by accident is not a delete.
  it('a deleted workflow cannot be saved or published back into the list', async () => {
    const { id } = (await create('deleted then edited', triggeredDefinition)).json() as {
      id: string;
    };
    expect((await call('DELETE', `/api/workflows/${id}`)).statusCode).toBe(204);

    const saved = await call('PATCH', `/api/workflows/${id}`, { name: 'back from the dead' });
    expect(saved.statusCode).toBe(409);
    const published = await call('POST', `/api/workflows/${id}/publish`);
    expect(published.statusCode).toBe(409);

    const listed = await call('GET', '/api/workflows?limit=10');
    expect((listed.json() as { items: unknown[] }).items).toEqual([]);
    // And the refusals are refusals, not writes that failed on the way out.
    const versions = (await call('GET', `/api/workflows/${id}/versions`)).json() as {
      items: { changeset: number; name: string }[];
    };
    expect(versions.items).toHaveLength(1);
    expect(versions.items[0]?.name).toBe('deleted then edited');
  });

  it('publish enforces the trigger-entry rule and then getLatestPublished resolves', async () => {
    const { id } = (await create('publishable', bareDefinition)).json() as { id: string };
    const rejected = await call('POST', `/api/workflows/${id}/publish`);
    expect(rejected.statusCode).toBe(422);
    expect((rejected.json() as { details: string[] }).details.join(' ')).toMatch(/trigger/i);

    await call('PATCH', `/api/workflows/${id}`, {
      nodes: triggeredDefinition.nodes,
      edges: triggeredDefinition.edges,
    });
    const published = await call('POST', `/api/workflows/${id}/publish`);
    expect(published.statusCode).toBe(200);
    expect((published.json() as { status: string }).status).toBe('published');

    const resolved = await store.getLatestPublished('t1', id);
    expect(resolved?.status).toBe('published');
    expect(resolved?.changeset).toBe(1);
  });

  it('viewers cannot create, update, publish or delete', async () => {
    const { id } = (await create('viewer-fixture', triggeredDefinition)).json() as { id: string };
    for (const [method, url, body] of [
      ['POST', '/api/workflows', { name: 'x', ...bareDefinition }],
      ['PATCH', `/api/workflows/${id}`, { nodes: bareDefinition.nodes, edges: bareDefinition.edges }],
      ['POST', `/api/workflows/${id}/publish`, undefined],
      ['DELETE', `/api/workflows/${id}`, undefined],
    ] as const) {
      const response = await call(method, url, body, viewerToken);
      expect(response.statusCode).toBe(403);
    }
    const listed = await call('GET', '/api/workflows?limit=10', undefined, viewerToken);
    expect(listed.statusCode).toBe(200);
  });

  it('trails the edit and the deletion, not only the creation', async () => {
    const { id } = (await create('audited', bareDefinition)).json() as { id: string };
    await call('PATCH', `/api/workflows/${id}`, { name: 'audited, renamed' });
    await call('DELETE', `/api/workflows/${id}`);
    const actions = (await audit.list('t1', { entityId: id })).map((entry) => entry.action);
    expect(actions).toContain('workflow.created');
    expect(actions).toContain('workflow.updated');
    expect(actions).toContain('workflow.deleted');
  });

  it('refuses to edit or delete a workflow owned by another tenant', async () => {
    const { id } = (await create('t1 private', bareDefinition)).json() as { id: string };
    const asOtherTenant = (method: 'GET' | 'PATCH' | 'DELETE', body?: unknown) =>
      otherApp.inject({
        method,
        url: `/api/workflows/${id}`,
        payload: body as Record<string, unknown> | undefined,
        headers: { authorization: `Bearer ${otherToken}` },
      });
    expect((await asOtherTenant('GET')).statusCode).toBe(404);
    expect((await asOtherTenant('PATCH', { name: 'stolen' })).statusCode).toBe(404);
    expect((await asOtherTenant('DELETE')).statusCode).toBe(404);

    // The refusals must be refusals, not writes that happened to miss: the
    // owner still reads the original name and an undeleted workflow.
    const owned = (await call('GET', `/api/workflows/${id}`)).json() as {
      name: string;
      deleted?: boolean;
    };
    expect(owned.name).toBe('t1 private');
    expect(owned.deleted).not.toBe(true);
  });

  it('answers 404 for an unknown workflow rather than inventing one', async () => {
    expect((await call('PATCH', '/api/workflows/wf_nope', { name: 'x' })).statusCode).toBe(404);
    expect((await call('DELETE', '/api/workflows/wf_nope')).statusCode).toBe(404);
  });

  // Two editors on one workflow both compute changeset latest + 1. The second
  // used to overwrite the first and both were answered 200, so the save that
  // was thrown away looked exactly like the one that was kept.
  it('answers 409 rather than discarding a concurrent save', async () => {
    const { id } = (await create('contested', bareDefinition)).json() as { id: string };
    const readLatest = store.getLatestVersion.bind(store);
    // The second editor's read, taken before the first editor saves.
    const stale = await readLatest('t1', id);

    expect((await call('PATCH', `/api/workflows/${id}`, { name: 'first editor' })).statusCode).toBe(
      200,
    );

    store.getLatestVersion = async () => stale;
    const second = await call('PATCH', `/api/workflows/${id}`, { name: 'second editor' });
    store.getLatestVersion = readLatest;

    expect(second.statusCode).toBe(409);
    const kept = await call('GET', `/api/workflows/${id}`);
    expect((kept.json() as { name: string }).name).toBe('first editor');
  });

  it('rejects an update whose body is not a workflow', async () => {
    const { id } = (await create('validated', bareDefinition)).json() as { id: string };
    const bad = await call('PATCH', `/api/workflows/${id}`, { name: '', nodes: [] });
    expect(bad.statusCode).toBe(400);
  });

  it('rejects a workflow with no nodes', async () => {
    const empty = await call('POST', '/api/workflows', { name: 'empty', nodes: [], edges: [] });
    expect(empty.statusCode).toBe(400);
  });

  it('round-trips the inspector data.* fields (policy, outputs, metadata)', async () => {
    const rich = {
      id: WORK,
      type: 'echo',
      version: 'v1',
      data: {
        label: 'Echo',
        description: 'notes here',
        config: { v: 1 },
        outputs: [{ manualData: [{ key: 'result', type: 'string', value: 'ok' }] }],
        metadata: { tags: ['billing', 'urgent'] },
        policy: {
          retries: 3,
          backoffSeconds: 5,
          timeoutSeconds: 30,
          onFailure: 'continue',
          idempotencyKey: 'order-key-1',
        },
      },
    };
    const created = await call('POST', '/api/workflows', { name: 'rich', nodes: [rich], edges: [] });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };

    const read = await call('GET', `/api/workflows/${id}`);
    const stored = (read.json() as { nodes: { data: Record<string, unknown> }[] }).nodes[0]?.data;
    expect(stored?.policy).toEqual(rich.data.policy);
    expect(stored?.outputs).toEqual(rich.data.outputs);
    expect(stored?.metadata).toEqual(rich.data.metadata);
    expect(stored?.description).toBe('notes here');
  });

  it('infers type "api" when the graph has an API Start node', async () => {
    const apiDefinition = {
      nodes: [
        node('start', 'apiconfig', { path: 'orders', method: 'POST' }),
        node(WORK, 'echo', { v: 3 }),
        node('end', 'apiend', { responseType: 'sourcedata' }),
      ],
      edges: [edge('start', WORK), edge(WORK, 'end')],
    };
    const created = await create('Orders API', apiDefinition);
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };
    const read = await call('GET', `/api/workflows/${id}`);
    // No type sent by the editor, but the API Start node makes it an api workflow.
    expect((read.json() as { type: string }).type).toBe('api');
  });
});

describe('publish-time schedule sync (a Schedule node IS the trigger declaration)', () => {
  let app: FastifyInstance;
  let token: string;
  let scheduleStore: WorkflowStore;
  let minted = 0;
  const bound: Record<string, unknown>[] = [];
  const triggers = {
    list: async () => bound,
    create: async (input: Record<string, unknown>) => {
      minted += 1;
      // What ScheduleService.create does: resolve the published definition NOW
      // and bake it into the Temporal Schedule action, which is written once
      // and replayed at every tick. Recording it here is how this suite can see
      // which graph the 2am run would actually execute.
      const published = await scheduleStore.getLatestPublished('t1', String(input.workflowId));
      const nodes = (published?.definition as { nodes?: { id: string }[] } | undefined)?.nodes ?? [];
      const record = { ...input, triggerId: `trg_${minted}`, bakedNodes: nodes.map((n) => n.id) };
      bound.push(record);
      return record;
    },
    remove: async (triggerId: string) => {
      const index = bound.findIndex((t) => t.triggerId === triggerId);
      if (index >= 0) bound.splice(index, 1);
    },
    setSecret: async (triggerId: string, secret: string) => {
      const record = bound.find((t) => t.triggerId === triggerId);
      if (!record) return false;
      record.secret = secret;
      return true;
    },
  };

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-schedsync-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'schedsync.db')));
    registerWorkflowTables(gateway);
    scheduleStore = new WorkflowStore(gateway);
    const identity = await SingleTenantIdentity.create('t1', [
      { userId: 'jeremy', secret: 'pw', role: 'admin' },
    ]);
    app = buildCoreServer({ identity, store: scheduleStore, triggers });
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { userId: 'jeremy', secret: 'pw' },
    });
    token = (login.json() as { token: string }).token;
  });

  afterAll(async () => {
    await app?.close();
  });

  const inject = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as Record<string, unknown> | undefined,
      headers: { authorization: `Bearer ${token}` },
    });

  it('publish binds the schedule, republish without the node removes it, delete cleans up', async () => {
    const scheduled = {
      name: 'nightly',
      nodes: [
        node('sched', 'scheduleconfig', { cron: '0 3 * * *', timezone: 'UTC' }),
        node(WORK, 'echo', { v: 1 }),
      ],
      edges: [edge('sched', WORK)],
    };
    const created = await inject('POST', '/api/workflows', scheduled);
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };

    const published = await inject('POST', `/api/workflows/${id}/publish`);
    expect(published.statusCode).toBe(200);
    expect((published.json() as { schedule?: string }).schedule).toBe('live');
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({ workflowId: id, kind: 'schedule', cron: '0 3 * * *' });

    // Republish unchanged: idempotent, still exactly one binding.
    await inject('POST', `/api/workflows/${id}/publish`);
    expect(bound).toHaveLength(1);

    // Edit the graph, keep the cron, republish. The Schedule's action carries
    // the definition resolved when it was created, so an unchanged cron used to
    // leave the 2am run executing a graph the editor no longer shows.
    const edited = await inject('PATCH', `/api/workflows/${id}`, {
      nodes: [
        node('sched', 'scheduleconfig', { cron: '0 3 * * *', timezone: 'UTC' }),
        node(WORK, 'echo', { v: 2 }),
        node(SIG, 'echo', { v: 3 }),
      ],
      edges: [edge('sched', WORK), edge(WORK, SIG)],
    });
    expect(edited.statusCode).toBe(200);
    await inject('POST', `/api/workflows/${id}/publish`);
    expect(bound).toHaveLength(1);
    expect(bound[0].cron).toBe('0 3 * * *');
    expect(bound[0].bakedNodes).toEqual(['sched', WORK, SIG]);

    // Remove the schedule node (keep a valid trigger entry) and republish:
    // the binding goes away.
    const withoutSchedule = await inject('PATCH', `/api/workflows/${id}`, {
      nodes: [node(SIG, 'signal', { signalType: 'manual' }), node(WORK, 'echo', { v: 2 })],
      edges: [edge(SIG, WORK)],
    });
    expect(withoutSchedule.statusCode).toBe(200);
    const republished = await inject('POST', `/api/workflows/${id}/publish`);
    expect((republished.json() as { schedule?: string }).schedule).toBe('removed');
    expect(bound).toHaveLength(0);
  });

  it('delete removes a live schedule binding', async () => {
    const created = await inject('POST', '/api/workflows', {
      name: 'doomed',
      nodes: [
        node('sched', 'scheduleconfig', { cron: '*/5 * * * *' }),
        node(WORK, 'echo', { v: 1 }),
      ],
      edges: [edge('sched', WORK)],
    });
    const { id } = created.json() as { id: string };
    await inject('POST', `/api/workflows/${id}/publish`);
    expect(bound.some((t) => t.workflowId === id)).toBe(true);
    await inject('DELETE', `/api/workflows/${id}`);
    expect(bound.some((t) => t.workflowId === id)).toBe(false);
  });
});
