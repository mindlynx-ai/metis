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
 * The MCP server, driven exactly as an AI client would: a real MCP client
 * over the SDK's linked in-memory transports, against a stubbed control
 * plane. Covers the login flow, tool listing, the catalogue tools (docs +
 * branch handles) and workflow create/run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer, MetisApiClient } from '../mcp.js';

const calls: { method: string; path: string; authed: boolean }[] = [];

function stubFetch(): typeof fetch {
  const routes: Record<string, unknown> = {
    'GET /api/node-catalogue': {
      entries: [
        {
          type: 'loop',
          category: 'logic',
          handler_status: 'ready',
          keywords: ['loop', 'iterate'],
          docs: '## What it is\nIterate items as child workflows.',
          configSchema: { type: 'object', properties: { items: { type: 'string' } } },
          palette: { label: 'Loop', description: 'Iterate over items.' },
        },
        { type: 'sql', category: 'transform', handler_status: 'not-a-node', palette: {} },
      ],
    },
    'GET /api/workflows?limit=50': { items: [{ id: 'wf-1', name: 'Demo', status: 'draft', nodes: [{}, {}] }] },
    'GET /api/workflows/wf-1': { id: 'wf-1', nodes: [{ id: 'node-a' }], edges: [] },
    'POST /api/workflows': { id: 'wf-new' },
    'POST /api/workflows/validate': { valid: true, errors: [] },
    'POST /api/workflows/wf-1/publish': { workflowId: 'wf-1', status: 'published' },
    'GET /api/connections': {
      connections: [
        { connectionId: 'conn-1', name: 'My SendGrid', connectorId: 'sendgrid', connectionType: 'rest' },
      ],
    },
    'POST /api/triggers': { triggerId: 'trg-1', kind: 'schedule', workflowId: 'wf-1', hint: 'live in Temporal now' },
    'GET /api/triggers': { items: [{ triggerId: 'trg-1', kind: 'schedule', workflowId: 'wf-1' }] },
    'POST /api/schedules/wf-1/pause': { workflowId: 'wf-1', paused: true },
    'POST /api/executions/exec-1/terminate': { executionId: 'exec-1', status: 'terminating' },
    'POST /api/executions': { executionId: 'exec-1' },
    'GET /api/executions/exec-1': {
      meta: { status: 'completed' },
      logs: [
        { nodeId: 'node-a', nodeType: 'code', event: 'workflow.node.started' },
        { nodeId: 'node-a', nodeType: 'code', event: 'workflow.node.completed', output: { ok: 1 } },
      ],
    },
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const key = `${method} ${url.pathname}${url.search}`;
    if (key === 'POST /api/auth/login') {
      return new Response(JSON.stringify({ token: 'tok-1' }), { status: 200 });
    }
    const authed = String((init?.headers as Record<string, string>)?.authorization ?? '').includes('tok-1');
    calls.push({ method, path: url.pathname, authed });
    const body = routes[key];
    if (!body) return new Response('{"error":"not found"}', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe('metis mcp', () => {
  let client: Client;

  beforeAll(async () => {
    const api = new MetisApiClient({
      url: 'http://stub',
      user: 'admin',
      secret: 'metis',
      fetchImpl: stubFetch(),
    });
    const server = buildMcpServer(api);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
  });

  const textOf = (result: unknown) =>
    JSON.parse(((result as { content: { text: string }[] }).content[0] ?? { text: 'null' }).text);

  it('exposes the full workflow-lifecycle tool set', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      'create_trigger',
      'create_workflow',
      'delete_trigger',
      'delete_workflow',
      'get_execution',
      'get_node_type',
      'get_workflow',
      'list_connections',
      'list_executions',
      'list_node_types',
      'list_triggers',
      'list_workflows',
      'manage_execution',
      'manage_schedule',
      'publish_workflow',
      'run_workflow',
      'update_workflow',
      'validate_workflow',
    ]);
  });

  it('closes the lifecycle gaps: connections, validate/publish, triggers, operate', async () => {
    const conns = textOf(await client.callTool({ name: 'list_connections', arguments: {} }));
    expect(conns).toEqual([
      { connectionId: 'conn-1', name: 'My SendGrid', connectorId: 'sendgrid', connectionType: 'rest' },
    ]);
    const validity = textOf(await client.callTool({ name: 'validate_workflow', arguments: { nodes: [], edges: [] } }));
    expect(validity).toEqual({ valid: true, errors: [] });
    const published = textOf(await client.callTool({ name: 'publish_workflow', arguments: { id: 'wf-1' } }));
    expect(published.status).toBe('published');
    const trigger = textOf(
      await client.callTool({ name: 'create_trigger', arguments: { workflowId: 'wf-1', kind: 'schedule', cron: '0 9 * * *' } }),
    );
    expect(trigger.triggerId).toBe('trg-1');
    expect(trigger.hint).toMatch(/Temporal/);
    const paused = textOf(await client.callTool({ name: 'manage_schedule', arguments: { workflowId: 'wf-1', action: 'pause' } }));
    expect(paused.paused).toBe(true);
    const terminated = textOf(
      await client.callTool({ name: 'manage_execution', arguments: { executionId: 'exec-1', action: 'terminate' } }),
    );
    expect(terminated.status).toBe('terminating');
  });

  it('logs in lazily and calls the API with the bearer token', async () => {
    const result = await client.callTool({ name: 'list_workflows', arguments: {} });
    expect(textOf(result)).toEqual([{ id: 'wf-1', name: 'Demo', status: 'draft', steps: 2 }]);
    expect(calls.every((call) => call.authed)).toBe(true);
  });

  it('the catalogue tools hide not-a-node entries and carry docs + branch handles', async () => {
    const list = textOf(await client.callTool({ name: 'list_node_types', arguments: { search: 'iterate' } }));
    expect(list).toEqual([
      { type: 'loop', category: 'logic', label: 'Loop', description: 'Iterate over items.' },
    ]);
    const detail = textOf(await client.callTool({ name: 'get_node_type', arguments: { type: 'loop' } }));
    expect(detail.docs).toMatch(/child workflows/);
    expect(detail.branchHandles).toMatch(/"each"/);
    // The demoted sql node never appears.
    const all = textOf(await client.callTool({ name: 'list_node_types', arguments: {} }));
    expect(all.map((entry: { type: string }) => entry.type)).toEqual(['loop']);
  });

  it('creates and runs a workflow, returning per-step outcomes', async () => {
    const created = textOf(
      await client.callTool({ name: 'create_workflow', arguments: { name: 'X', nodes: [], edges: [] } }),
    );
    expect(created).toEqual({ id: 'wf-new' });
    const run = textOf(await client.callTool({ name: 'run_workflow', arguments: { id: 'wf-1' } }));
    expect(run.executionId).toBe('exec-1');
    expect(run.status).toBe('completed');
    expect(run.steps).toEqual([
      { nodeId: 'node-a', nodeType: 'code', outcome: 'completed', output: { ok: 1 } },
    ]);
  }, 30_000);
});
