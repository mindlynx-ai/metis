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
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
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
  let store: WorkflowStore;
  let adminToken: string;
  let viewerToken: string;

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
    store = new WorkflowStore(gateway);
    const identity = await SingleTenantIdentity.create('t1', [
      { userId: 'jeremy', secret: 'pw', role: 'admin' },
      { userId: 'watcher', secret: 'pw', role: 'viewer' },
    ]);
    app = buildCoreServer({ identity, store });
    await app.ready();
    const login = async (userId: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { userId, secret: 'pw' },
      });
      return (response.json() as { token: string }).token;
    };
    adminToken = await login('jeremy');
    viewerToken = await login('watcher');
  });

  afterAll(async () => {
    await app?.close();
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
  const bound: Record<string, unknown>[] = [];
  const triggers = {
    list: async () => bound,
    create: async (input: Record<string, unknown>) => {
      const record = { ...input, triggerId: `trg_${bound.length + 1}` };
      bound.push(record);
      return record;
    },
    remove: async (triggerId: string) => {
      const index = bound.findIndex((t) => t.triggerId === triggerId);
      if (index >= 0) bound.splice(index, 1);
    },
  };

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-schedsync-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'schedsync.db')));
    registerWorkflowTables(gateway);
    const store = new WorkflowStore(gateway);
    const identity = await SingleTenantIdentity.create('t1', [
      { userId: 'jeremy', secret: 'pw', role: 'admin' },
    ]);
    app = buildCoreServer({ identity, store, triggers });
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
