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
 * The Metis MCP server (`metis mcp`): a stdio Model Context Protocol server
 * that lets an AI tool build and run workflows against a RUNNING Metis
 * instance. It is a thin HTTP client of the control plane (never an embedded
 * runtime), so it works against `metis up`, docker compose or a remote box:
 *   METIS_URL    the control plane (default http://localhost:3000)
 *   METIS_TOKEN  a bearer token; or METIS_USER/METIS_SECRET to log in
 *                (default admin/metis - the local dev seed).
 * stdio discipline: stdout carries ONLY protocol frames; logs go to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/** The canvas handle ids each branching node routes by - an edge whose
 *  sourceHandle does not match never fires. Mirrors the engine + editor. */
const BRANCH_HANDLES: Record<string, string> = {
  switch: 'one handle per configured branch: "source-<option.id>" plus the fall-through "source-default"',
  logic: '"true" (Yes) and "false" (No)',
  loop: '"each" (the body, run once per batch as a child workflow) and "done" (continues after)',
  filter: '"kept" and "discarded" (an empty side is orphaned and does not run)',
  comparedatasets: '"aOnly", "same", "different", "bOnly" (empty sides are orphaned)',
  stopanderror: 'none - terminal, the run stops here',
};

const NODE_SHAPE_HELP = [
  'A node is {"id":"node-<uuid>","type":"<node type>","version":"v1",',
  '"position":{"x":0,"y":0},"data":{"label":"<name>","config":{...}}}.',
  'An edge is {"id":"<any>","source":"<node id>","target":"<node id>",',
  '"sourceHandle":null} - use the branch handle id (see get_node_type) when',
  'the source is a branching node. Reference an earlier step\'s output inside',
  'config strings as {{node-<id>.data.<path>}}. The graph needs exactly one',
  'start node (no incoming edges) and no cycles.',
].join(' ');

export interface McpEnv {
  url: string;
  token?: string;
  user: string;
  secret: string;
  fetchImpl?: typeof fetch;
}

/** A tiny authenticated client for the Metis control plane. */
export class MetisApiClient {
  private token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly env: McpEnv) {
    this.token = env.token;
    this.fetchImpl = env.fetchImpl ?? fetch;
  }

  private async login(): Promise<string> {
    const response = await this.fetchImpl(`${this.env.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: this.env.user, secret: this.env.secret }),
    });
    if (!response.ok) throw new Error(`login failed (${response.status}) - set METIS_TOKEN or METIS_USER/METIS_SECRET`);
    const body = (await response.json()) as { token: string };
    this.token = body.token;
    return body.token;
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.token ?? (await this.login());
    const response = await this.fetchImpl(`${this.env.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401) {
      // The token died (restart, expiry): log in once and retry.
      this.token = undefined;
      await this.login();
      return this.call(method, path, body);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`${method} ${path} -> ${response.status}: ${detail.slice(0, 300)}`);
    }
    // 204 (delete) and other empty responses have no JSON body.
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

interface CatalogueEntry {
  type: string;
  category: string;
  handler_status?: string;
  alias_of?: string;
  keywords?: string[];
  docs?: string;
  configSchema?: unknown;
  outputSchema?: unknown;
  palette?: { label?: string; description?: string };
}

/** Build the MCP server against a Metis API client (transport supplied by the caller). */
export function buildMcpServer(api: MetisApiClient): McpServer {
  const server = new McpServer({ name: 'metis', version: '0.1.0' });

  const catalogue = async (): Promise<CatalogueEntry[]> => {
    const result = await api.call<{ entries: CatalogueEntry[] }>('GET', '/api/node-catalogue');
    return result.entries.filter((entry) => entry.handler_status !== 'not-a-node' && !entry.alias_of);
  };

  server.registerTool(
    'list_node_types',
    {
      description:
        'The node types available for building workflows: type id, category, label, one-line description. Use get_node_type for a type\'s config schema, full docs and branch handles.',
      inputSchema: { search: z.string().optional().describe('Filter by keyword, label or type id') },
    },
    async ({ search }) => {
      const entries = await catalogue();
      const query = (search ?? '').toLowerCase().trim();
      const matches = entries.filter((entry) => {
        if (query === '') return true;
        const haystack = [entry.type, entry.palette?.label, entry.palette?.description, ...(entry.keywords ?? [])]
          .join(' ')
          .toLowerCase();
        return haystack.includes(query);
      });
      return text(
        matches.map((entry) => ({
          type: entry.type,
          category: entry.category,
          label: entry.palette?.label,
          description: entry.palette?.description,
        })),
      );
    },
  );

  server.registerTool(
    'get_node_type',
    {
      description:
        'Everything about one node type: config schema, output schema, long-form docs, and (for branching nodes) the sourceHandle ids its edges must use.',
      inputSchema: { type: z.string().describe('The node type id, e.g. "loop" or "data"') },
    },
    async ({ type }) => {
      const entries = await catalogue();
      const entry = entries.find((candidate) => candidate.type === type);
      if (!entry) return text(`unknown node type "${type}" - call list_node_types first`);
      return text({
        type: entry.type,
        category: entry.category,
        label: entry.palette?.label,
        description: entry.palette?.description,
        branchHandles: BRANCH_HANDLES[entry.type] ?? 'single unnamed output: use sourceHandle null',
        configSchema: entry.configSchema,
        outputSchema: entry.outputSchema,
        docs: entry.docs,
      });
    },
  );

  server.registerTool(
    'list_workflows',
    { description: 'The workflows in this Metis instance (id, name, status, step count).', inputSchema: {} },
    async () => {
      const result = await api.call<{ items: { id: string; name: string; status: string; nodes?: unknown[] }[] }>(
        'GET',
        '/api/workflows?limit=50',
      );
      return text(
        result.items.map((item) => ({
          id: item.id,
          name: item.name,
          status: item.status,
          steps: item.nodes?.length ?? 0,
        })),
      );
    },
  );

  server.registerTool(
    'get_workflow',
    {
      description: 'One workflow\'s full definition (nodes + edges), ready to modify and save back with update_workflow.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => text(await api.call('GET', `/api/workflows/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    'create_workflow',
    {
      description: `Create a workflow from nodes + edges. ${NODE_SHAPE_HELP}`,
      inputSchema: {
        name: z.string(),
        nodes: z.array(z.record(z.string(), z.unknown())).describe('Workflow nodes (see the shape in the tool description)'),
        edges: z.array(z.record(z.string(), z.unknown())).describe('Edges wiring the nodes'),
      },
    },
    async ({ name, nodes, edges }) => text(await api.call('POST', '/api/workflows', { name, nodes, edges })),
  );

  server.registerTool(
    'update_workflow',
    {
      description: `Replace a workflow's definition (and optionally rename it). ${NODE_SHAPE_HELP}`,
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        nodes: z.array(z.record(z.string(), z.unknown())),
        edges: z.array(z.record(z.string(), z.unknown())),
      },
    },
    async ({ id, name, nodes, edges }) => {
      await api.call('PATCH', `/api/workflows/${encodeURIComponent(id)}`, { name, nodes, edges });
      return text({ id, updated: true });
    },
  );

  server.registerTool(
    'run_workflow',
    {
      description:
        'Run a workflow and wait briefly for the result. Returns the run status plus each completed step\'s output; if still running after ~15s, poll with get_execution.',
      inputSchema: {
        id: z.string(),
        input: z.record(z.string(), z.unknown()).optional().describe('The run input (what the trigger would deliver)'),
      },
    },
    async ({ id, input }) => {
      const workflow = await api.call<{ nodes: unknown[]; edges: unknown[] }>(
        'GET',
        `/api/workflows/${encodeURIComponent(id)}`,
      );
      const started = await api.call<{ executionId: string }>('POST', '/api/executions', {
        workflowId: id,
        definition: { nodes: workflow.nodes, edges: workflow.edges },
        input: input ?? {},
      });
      let detail: { meta: { status: string }; logs: Record<string, unknown>[] } | undefined;
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        detail = await api.call('GET', `/api/executions/${encodeURIComponent(started.executionId)}`);
        if (detail !== undefined && detail.meta.status !== 'running') break;
      }
      return text({
        executionId: started.executionId,
        status: detail?.meta.status ?? 'running',
        steps: summariseLogs(detail?.logs ?? []),
      });
    },
  );

  server.registerTool(
    'get_execution',
    {
      description: 'A run\'s status and per-step outcomes/outputs (including loop child runs by their execution id).',
      inputSchema: { executionId: z.string() },
    },
    async ({ executionId }) => {
      const detail = await api.call<{ meta: Record<string, unknown>; logs: Record<string, unknown>[] }>(
        'GET',
        `/api/executions/${encodeURIComponent(executionId)}`,
      );
      // Family + whereabouts (parked on what, retrying where) ride along.
      const insight = await api
        .call<Record<string, unknown>>('GET', `/api/executions/${encodeURIComponent(executionId)}/insight`)
        .catch(() => undefined);
      return text({
        meta: detail.meta,
        steps: summariseLogs(detail.logs),
        whereabouts: insight?.whereabouts,
        parentExecutionId: insight?.parentExecutionId,
        children: insight?.children,
        pendingActivities: insight?.pendingActivities,
      });
    },
  );

  server.registerTool(
    'list_executions',
    {
      description: 'Recent runs from Temporal visibility, optionally filtered by status (Running, Completed, Failed, Terminated, Canceled).',
      inputSchema: { status: z.string().optional() },
    },
    async ({ status }) => {
      const suffix = status ? `?status=${encodeURIComponent(status)}` : '';
      return text(await api.call('GET', `/api/executions/temporal${suffix}`));
    },
  );

  server.registerTool(
    'validate_workflow',
    {
      description:
        'Dry-check a graph (start node, cycles, loop/branch rules) WITHOUT saving. Returns { valid, errors }. Run this before create_workflow when unsure.',
      inputSchema: {
        nodes: z.array(z.record(z.string(), z.unknown())),
        edges: z.array(z.record(z.string(), z.unknown())),
      },
    },
    async ({ nodes, edges }) =>
      text(await api.call('POST', '/api/workflows/validate', { name: 'validate', nodes, edges })),
  );

  server.registerTool(
    'publish_workflow',
    {
      description:
        'Publish a workflow: make the current draft the live version a trigger can fire. Fails (422) if the definition is invalid at publish level.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => text(await api.call('POST', `/api/workflows/${encodeURIComponent(id)}/publish`)),
  );

  server.registerTool(
    'delete_workflow',
    { description: 'Soft-delete a workflow.', inputSchema: { id: z.string() } },
    async ({ id }) => {
      await api.call('DELETE', `/api/workflows/${encodeURIComponent(id)}`);
      return text({ id, deleted: true });
    },
  );

  server.registerTool(
    'list_connections',
    {
      description:
        'The saved connections (metadata only, never secrets). A connector node (e.g. sendgrid, postgres) sets its config.connectorId to one of these connectionId values.',
      inputSchema: {},
    },
    async () => {
      const result = await api.call<{ connections: Record<string, unknown>[] }>('GET', '/api/connections');
      return text(
        result.connections.map((c) => ({
          connectionId: c.connectionId,
          name: c.name,
          connectorId: c.connectorId,
          connectionType: c.connectionType,
        })),
      );
    },
  );

  server.registerTool(
    'manage_execution',
    {
      description:
        'Operate a run: cancel (graceful - the run finalises its own state), terminate (hard stop) or reset (re-run from the first step).',
      inputSchema: {
        executionId: z.string(),
        action: z.enum(['cancel', 'terminate', 'reset']),
      },
    },
    async ({ executionId, action }) => {
      const result = await api.call('POST', `/api/executions/${encodeURIComponent(executionId)}/${action}`);
      return text(result ?? { executionId, action });
    },
  );

  server.registerTool(
    'create_trigger',
    {
      description:
        'Bind a trigger so a PUBLISHED workflow fires on its own. kind "webhook" (returns a /hooks URL), "schedule" (needs cron, e.g. "0 9 * * *"; live in Temporal immediately), or "poll" (a connector operation). Publish the workflow first.',
      inputSchema: {
        workflowId: z.string(),
        kind: z.enum(['webhook', 'schedule', 'poll']),
        cron: z.string().optional().describe('schedule: 5-field cron'),
        verification: z.enum(['github', 'hmac', 'none']).optional().describe('webhook: signature scheme'),
        secret: z.string().optional().describe('webhook: shared secret'),
        connectorId: z.string().optional().describe('poll: the connection id'),
        operation: z.string().optional().describe('poll: the connector operation'),
        event: z.string().optional(),
      },
    },
    async (args) => text(await api.call('POST', '/api/triggers', args)),
  );

  server.registerTool(
    'list_triggers',
    { description: 'The triggers bound to workflows (webhook/schedule/poll).', inputSchema: {} },
    async () => text(await api.call('GET', '/api/triggers')),
  );

  server.registerTool(
    'delete_trigger',
    { description: 'Remove a trigger (a schedule trigger also removes its Temporal Schedule).', inputSchema: { triggerId: z.string() } },
    async ({ triggerId }) => {
      await api.call('DELETE', `/api/triggers/${encodeURIComponent(triggerId)}`);
      return text({ triggerId, deleted: true });
    },
  );

  server.registerTool(
    'manage_schedule',
    {
      description: 'Pause or resume a workflow\'s schedule (it stays defined; firing stops until resumed).',
      inputSchema: { workflowId: z.string(), action: z.enum(['pause', 'unpause']) },
    },
    async ({ workflowId, action }) =>
      text(await api.call('POST', `/api/schedules/${encodeURIComponent(workflowId)}/${action}`)),
  );

  return server;
}

/** Compact per-node view of an execution's logs (completed outputs + errors). */
function summariseLogs(logs: Record<string, unknown>[]): Record<string, unknown>[] {
  return logs
    .filter((log) => {
      const event = String(log.event ?? '');
      return event.endsWith('node.completed') || event.endsWith('node.failed');
    })
    .map((log) => ({
      nodeId: log.nodeId,
      nodeType: log.nodeType,
      outcome: String(log.event ?? '').endsWith('node.failed') ? 'failed' : 'completed',
      output: log.output,
      error: log.error,
    }));
}

/** The `metis mcp` command: serve MCP over stdio until the client hangs up. */
export async function cmdMcp(): Promise<number> {
  const api = new MetisApiClient({
    url: process.env.METIS_URL ?? 'http://localhost:3000',
    token: process.env.METIS_TOKEN,
    user: process.env.METIS_USER ?? 'admin',
    secret: process.env.METIS_SECRET ?? 'metis',
  });
  const server = buildMcpServer(api);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`metis mcp: serving ${process.env.METIS_URL ?? 'http://localhost:3000'} over stdio\n`);
  // Stay alive until the client closes the pipe.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  return 0;
}
