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
 * The system suite that runs unattended against a live
 * `metis up` runtime: auth, workflow CRUD, publish validation, execution
 * lifecycle, the local-compute node types (code/transform/switch/waituntil/
 * signal), the http node via a loopback self-call, parameter substitution,
 * and the code/language schema-vs-handler divergence. Network-dependent
 * nodes (connector/postgres/sendgrid) and the trigger proofs live in their
 * own scripts because they need external services or a runtime restart.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BASE,
  client,
  edge,
  login,
  node,
  nodeId,
  nodeResult,
  runInline,
  runtimeUp,
  type RunLog,
} from './harness.js';

const up = await runtimeUp();
const suite = up ? describe : describe.skip;
if (!up) {
  // eslint-disable-next-line no-console
  console.warn(`[system] no runtime at ${BASE}; skipping. Start "metis up" or set METIS_URL.`);
}

let api: ReturnType<typeof client>;
let anonymous: ReturnType<typeof client>;
let wf: string; // a reusable workflow id for inline executions

async function createWorkflow(body: Record<string, unknown>) {
  return api<{ workflowId: string }>('POST', '/api/workflows', body);
}

const signalStart = (id = nodeId()) => node(id, 'signal', { signalType: 'manual' }, 'Start');
const codeNode = (cfg: Record<string, unknown>, id = nodeId()) => node(id, 'code', cfg, 'Code');

suite('Metis system suite', () => {
  beforeAll(async () => {
    const token = await login();
    api = client(token);
    anonymous = client();
    const created = await createWorkflow({
      name: 'system-suite-fixture',
      type: 'workflow',
      nodes: [signalStart(), codeNode({ code: 'return { ok: true };' })],
      edges: [],
    });
    wf = created.body.workflowId;
  });

  describe('auth + RBAC', () => {
    it('AUTH-01/07/08 valid login exposes session + entitlements', async () => {
      const me = await api('GET', '/api/auth/me');
      expect(me.status).toBe(200);
      const ent = await api<{ edition: string }>('GET', '/api/entitlements');
      expect(ent.status).toBe(200);
      expect(ent.body.edition).toBe('open');
    });

    it('AUTH-02/04 bad credentials and malformed login are rejected', async () => {
      const bad = await client()('POST', '/api/auth/login', { userId: 'admin', secret: 'wrong' });
      expect(bad.status).toBe(401);
      const malformed = await client()('POST', '/api/auth/login', {});
      expect(malformed.status).toBe(400);
    });

    it('AUTH-05 missing token is unauthorised', async () => {
      const res = await anonymous('GET', '/api/workflows');
      expect(res.status).toBe(401);
    });
  });

  describe('workflow CRUD', () => {
    it('WF-CREATE-01 create seeds version 1 / changeset 0 with a wf_ id', async () => {
      const created = await createWorkflow({
        name: 'crud-create',
        nodes: [signalStart()],
        edges: [],
      });
      expect(created.status).toBe(201);
      expect(created.body.workflowId).toMatch(/^wf_/);
      expect(created.body).toMatchObject({ version: 1, changeset: 0 });
    });

    it('WF-CREATE-03/04/05 name and node validation', async () => {
      const noName = await createWorkflow({ nodes: [signalStart()], edges: [] });
      expect(noName.status).toBe(400);
      const longName = await createWorkflow({
        name: 'x'.repeat(201),
        nodes: [signalStart()],
        edges: [],
      });
      expect(longName.status).toBe(400);
      const empty = await createWorkflow({ name: 'empty', nodes: [], edges: [] });
      expect(empty.status).toBe(400);
    });

    it('WF-CREATE-06 an edge missing the sourceHandle key is rejected', async () => {
      const a = nodeId();
      const b = nodeId();
      const res = await createWorkflow({
        name: 'bad-edge',
        nodes: [signalStart(a), codeNode({ code: 'return 1;' }, b)],
        edges: [{ id: 'e', source: a, target: b }], // sourceHandle key omitted
      });
      expect(res.status).toBe(400);
    });

    it('WF-GET/UPD/DEL round-trip: changeset increments, update forces draft, delete is idempotent', async () => {
      const created = await createWorkflow({
        name: 'lifecycle',
        status: 'published',
        nodes: [signalStart()],
        edges: [],
      });
      const id = created.body.workflowId;

      const got = await api<{ name: string; version: number; changeset: number }>(
        'GET',
        `/api/workflows/${id}`,
      );
      expect(got.status).toBe(200);
      expect(got.body.name).toBe('lifecycle');

      const patched = await api<{ version: number; changeset: number }>(
        'PATCH',
        `/api/workflows/${id}`,
        { name: 'lifecycle-2' },
      );
      expect(patched.status).toBe(200);
      expect(patched.body.changeset).toBe(1);

      const afterPatch = await api<{ name: string; status: string }>('GET', `/api/workflows/${id}`);
      expect(afterPatch.body.name).toBe('lifecycle-2');
      expect(afterPatch.body.status).toBe('draft'); // update un-publishes

      const del1 = await api('DELETE', `/api/workflows/${id}`);
      expect(del1.status).toBe(204);
      const del2 = await api('DELETE', `/api/workflows/${id}`); // idempotent
      expect(del2.status).toBe(204);

      // Soft delete: the workflow drops out of the list index...
      const list = await api<{ items: { id: string }[] }>('GET', '/api/workflows?limit=100');
      expect(list.body.items.some((w) => w.id === id)).toBe(false);
      // ...but a direct GET by id still resolves the row (observation: delete
      // is soft; it hides from listing, it does not 404 a direct read).
      const direct = await api('GET', `/api/workflows/${id}`);
      expect(direct.status).toBe(200);
    });

    it('WF-GET-03 unknown workflow is 404', async () => {
      const res = await api('GET', '/api/workflows/wf_does-not-exist');
      expect(res.status).toBe(404);
    });
  });

  describe('publish validation', () => {
    const publishGraph = async (
      name: string,
      nodes: ReturnType<typeof node>[],
      edges: ReturnType<typeof edge>[],
      type = 'workflow',
    ) => {
      const created = await createWorkflow({ name, type, nodes, edges });
      const id = created.body.workflowId;
      return api<{ status?: string; error?: string; details?: string[] }>(
        'POST',
        `/api/workflows/${id}/publish`,
      );
    };

    it('WF-PUB-01 a trigger-started graph publishes', async () => {
      const a = nodeId();
      const b = nodeId();
      const res = await publishGraph(
        'pub-valid',
        [signalStart(a), codeNode({ code: 'return 1;' }, b)],
        [edge(a, b)],
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('published');
    });

    it('WF-PUB-07 a non-trigger start is rejected', async () => {
      const res = await publishGraph('pub-nontrigger', [codeNode({ code: 'return 1;' })], []);
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body.details)).toMatch(/trigger node/i);
    });

    it('WF-PUB-06 more than one start node is rejected', async () => {
      const res = await publishGraph(
        'pub-two-starts',
        [signalStart(), signalStart()],
        [],
      );
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body.details)).toMatch(/start node/i);
    });

    it('WF-PUB-04 a dangling edge is rejected', async () => {
      const a = nodeId();
      const res = await publishGraph(
        'pub-dangling',
        [signalStart(a)],
        [edge(a, 'node-00000000-0000-4000-8000-000000000000')],
      );
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body.details)).toMatch(/missing node/i);
    });
  });

  describe('execution lifecycle', () => {
    it('EXEC-START-04 starting an unpublished workflow with no inline def is 404', async () => {
      const draft = await createWorkflow({ name: 'draft', nodes: [signalStart()], edges: [] });
      const res = await api('POST', '/api/executions', { workflowId: draft.body.workflowId });
      expect(res.status).toBe(404);
    });

    it('EXEC-START-05 an inline definition with no nodes is 422', async () => {
      const res = await api('POST', '/api/executions', {
        workflowId: wf,
        definition: { nodes: [], edges: [] },
      });
      expect(res.status).toBe(422);
    });

    it('EXEC-START-07 missing workflowId is 400', async () => {
      const res = await api('POST', '/api/executions', { input: {} });
      expect(res.status).toBe(400);
    });

    it('EXEC-READ-07 per-node logs carry nodeId/nodeType/event/outcome/output', async () => {
      // A code node's `input` global is its own config.input (the run input
      // seeds trigger nodes, not a lone code node).
      const c = codeNode({ code: 'return { v: input.n };', input: { n: 7 } });
      const run = await runInline(api, wf, [c]);
      expect(run.status).toBe('completed');
      const started = run.logs.find((l) => l.event === 'workflow.node.started');
      expect(started?.nodeId).toBe(c.id);
      const done = nodeResult(run.logs, c.id);
      expect(done?.outcome).toBe('completed');
      expect(done?.output).toMatchObject({ v: 7 });
    });
  });

  describe('local-compute node types', () => {
    it('NODE-CODE-01/02 code returns a value and reads its config.input', async () => {
      const c = codeNode({ code: 'return { doubled: input.n * 2 };', input: { n: 21 } });
      const run = await runInline(api, wf, [c]);
      expect(nodeResult(run.logs, c.id)?.output).toMatchObject({ doubled: 42 });
    });

    it('NODE-CODE-05 the sandbox has no fetch or require', async () => {
      const c = codeNode({ code: 'return { f: typeof fetch, r: typeof require };' });
      const run = await runInline(api, wf, [c]);
      expect(nodeResult(run.logs, c.id)?.output).toMatchObject({ f: 'undefined', r: 'undefined' });
    });

    it('NODE-CODE-06 Date.now is blocked (node fails)', async () => {
      const c = codeNode({ code: 'return Date.now();' });
      const run = await runInline(api, wf, [c]);
      expect(nodeResult(run.logs, c.id)?.outcome).toBe('failed');
    });

    it('NODE-CODE-10 transform behaves like code (alias)', async () => {
      const t = node(nodeId(), 'transform', { code: 'return { via: "transform" };' }, 'T');
      const run = await runInline(api, wf, [t]);
      expect(nodeResult(run.logs, t.id)?.output).toMatchObject({ via: 'transform' });
    });

    it('NODE-SIG-01 a manual signal entry node auto-resumes', async () => {
      const run = await runInline(api, wf, [signalStart()]);
      expect(run.status).toBe('completed');
    });

    it('NODE-SW-01/02 switch selects a matching branch, else default', async () => {
      const gold = node(
        nodeId(),
        'switch',
        {
          switchOptions: [
            { id: 'b1', conditions: [{ property: 'input.tier', checkValue: 'gold', checkOperator: '===' }] },
          ],
        },
        'Switch',
      );
      const goldRun = await runInline(api, wf, [gold], [], { tier: 'gold' });
      expect(JSON.stringify(nodeResult(goldRun.logs, gold.id)?.output)).toMatch(/b1/);

      const bronze = node(nodeId(), 'switch', gold.data.config, 'Switch');
      const bronzeRun = await runInline(api, wf, [bronze], [], { tier: 'bronze' });
      expect(JSON.stringify(nodeResult(bronzeRun.logs, bronze.id)?.output)).toMatch(/default/);
    });

    it('NODE-WU-01 waituntil sleeps then completes', async () => {
      const w = node(nodeId(), 'waituntil', { waitSeconds: 1 }, 'Wait');
      const run = await runInline(api, wf, [w]);
      expect(run.status).toBe('completed');
    });
  });

  describe('http node (loopback self-call)', () => {
    it('NODE-HTTP-01 GET the runtime root with allowedHosts succeeds', async () => {
      const h = node(
        nodeId(),
        'http',
        { url: 'http://127.0.0.1:3000/', method: 'GET', allowedHosts: ['127.0.0.1'] },
        'HTTP',
      );
      const run = await runInline(api, wf, [h]);
      const out = nodeResult(run.logs, h.id)?.output as { status?: number } | undefined;
      expect(out?.status).toBe(200);
    });

    it('NODE-HTTP-02 loopback is SSRF-blocked without allowedHosts', async () => {
      const h = node(
        nodeId(),
        'http',
        { url: 'http://127.0.0.1:3000/', method: 'GET' },
        'HTTP',
      );
      const run = await runInline(api, wf, [h]);
      const result = nodeResult(run.logs, h.id);
      expect(result?.outcome).toBe('failed');
      expect(JSON.stringify(result?.error)).toMatch(/ssrf/i);
    });
  });

  describe('parameter substitution', () => {
    it('SUBST-01 a downstream node reads an upstream output via {{node-<id>.data.<field>}}', async () => {
      const a = codeNode({ code: 'return { x: 5 };' });
      const bId = nodeId();
      const b = codeNode({ code: `return { fromA: {{${a.id}.data.x}} };` }, bId);
      const run = await runInline(api, wf, [a, b], [edge(a.id, b.id)]);
      expect(nodeResult(run.logs, b.id)?.output).toMatchObject({ fromA: 5 });
    });
  });

  describe('schema-vs-handler divergences (recorded, not fixed)', () => {
    it('NODE-CODE language:python still runs JS (handler ignores language)', async () => {
      // `return 5` is a JS return, but a Python SyntaxError. Completing proves
      // the handler runs JS regardless of the declared language.
      const c = node(nodeId(), 'code', { code: 'return { ran: "js" };', language: 'python' }, 'Py');
      const run = await runInline(api, wf, [c]);
      const result: RunLog | undefined = nodeResult(run.logs, c.id);
      expect(result?.outcome).toBe('completed');
      expect(result?.output).toMatchObject({ ran: 'js' });
    });
  });
});
