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
 * The editor's API client: bearer sessions against metis-core (the
 * collapsed laptop runtime). Vite proxies /api to the control plane.
 */

// The Helix-exact node/edge shape (helix-core workflowNodeSchema): config
// lives under data.config, a required version string, nullable sourceHandle.
export interface NodePolicy {
  retries?: number;
  backoffSeconds?: number;
  timeoutSeconds?: number;
  onFailure?: 'halt' | 'continue';
}

export interface WorkflowNodeData {
  label: string;
  description?: string;
  config: Record<string, unknown>;
  outputs?: unknown[];
  metadata?: Record<string, unknown>;
  policy?: NodePolicy;
}

export interface WorkflowNode {
  id: string;
  type: string;
  version: string;
  data: WorkflowNodeData;
  position?: { x: number; y: number };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string | null;
}

/** The workflow-level cloud toggle + the consent stamp the gate writes. */
export interface CloudRouting {
  enabled?: boolean;
  consentAt?: string;
}

/** A workflow in the Helix-flat wire shape (top-level nodes/edges). */
export interface WorkflowItem {
  id: string;
  name: string;
  description?: string;
  type: string;
  status: string;
  version: number;
  changeset: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  cloudRouting?: CloudRouting;
}

/** One execution as Temporal's visibility API reports it (the UI view). */
export interface TemporalExecution {
  workflowId: string;
  runId: string;
  type: string;
  status: string;
  startTime?: string;
  closeTime?: string;
  historyLength?: number;
  taskQueue?: string;
  /** The METIS workflow this run belongs to (name + id), when known. */
  workflowName?: string;
  metisWorkflowId?: string;
  /** Which definition version this run executed. */
  definitionVersion?: number;
  definitionChangeset?: number;
  /** Whereabouts for running executions: parked or actively at a step. */
  runState?: 'waiting' | 'running';
  waitingOn?: { signalType?: string; until?: string };
  atNode?: string;
}

/**
 * The subset of JSON Schema the inspector reads, plus the Helix widget
 * hints the catalogue carries (`x-helix-widget`, `x-helix-options`).
 */
export interface JsonSchemaProperty {
  type?: string;
  enum?: unknown[];
  description?: string;
  title?: string;
  default?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  'x-helix-widget'?: string;
  'x-helix-options'?: string;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/** One typed input an operation receives (a labelled inspector field). */
export interface OperationParameter {
  key: string;
  label: string;
  required?: boolean;
  type?: 'string' | 'text' | 'email' | 'number' | 'boolean';
  placeholder?: string;
  description?: string;
}

/** One typed output an operation gives back (a downstream variable). */
export interface OperationOutput {
  key: string;
  label?: string;
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
}

/** One operation on a connector (name + method + templated path + inputs/outputs). */
export interface ConnectorOperation {
  name: string;
  method: string;
  pathTemplate: string;
  description?: string;
  parameters?: OperationParameter[];
  outputs?: OperationOutput[];
}

/** A connector definition from the connector catalogue. */
/** One credential field a connector's connection needs. */
export interface CredentialFieldDef {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface ConnectorDef {
  connectorId: string;
  name: string;
  baseUrl: string;
  authScheme?: string;
  category?: string;
  operations?: ConnectorOperation[];
  /** The credential fields this connector needs (Stripe carries three). */
  credentials?: CredentialFieldDef[];
  /** A brand hue for the connector's mark. */
  brandColor?: string;
}

/** The health verdict for a connection (observability). */
export interface ConnectionHealth {
  status: 'ok' | 'auth_failed' | 'unreachable' | 'error';
  ok: boolean;
  message?: string;
  checkedAt: string;
}

/** A connection: a named instance of a connector type. */
export interface ConnectionRecord {
  connectionId: string;
  name: string;
  /** The connector TYPE this is an instance of (a catalogue id, or the class). */
  connectorId: string;
  /** The class: rest | client_credentials | database. */
  connectionType?: string;
  baseUrl?: string;
  authScheme?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CatalogueEntry {
  /** Long-form node documentation (markdown) for the Guide tab. */
  docs?: string;
  type: string;
  category: string;
  /** The picker browse group (app category, e.g. 'communication'). */
  group?: string;
  /** Search synonyms for the picker. */
  keywords?: string[];
  tier: string;
  alias_of?: string;
  handler_status?: string;
  status?: string;
  /** Where the node can run ('local' when absent); 'both' pairs with an entitlement. */
  execution?: 'local' | 'cloud' | 'both';
  /** The capability id (e.g. 'cap.data') that unlocks the cloud backend. */
  entitlement?: string;
  configSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  palette?: { label?: string; description?: string; icon?: string; colour?: string };
}

/** One per-node log line as the engine's activities append it. */
export interface RunLog {
  nodeId?: string;
  nodeType?: string;
  event?: string;
  outcome?: string;
  output?: unknown;
  error?: { message?: string; code?: string };
  /** Attempts the policy retry loop used (present when a policy applied). */
  attempts?: number;
  sequence?: number;
  at?: string;
  /** Where the step actually ran ('local-degraded' = cloud chosen, ran here). */
  binding?: 'local' | 'cloud' | 'local-degraded';
  /** The consent receipt line (event 'workflow.cloud.routing') carries these. */
  decision?: 'allowed' | 'kept-local';
  consentAt?: string;
  /** 'run' = consent for this run only; anything else = remembered. */
  scope?: 'run' | 'workflow';
}

export interface ExecutionDetail {
  meta: {
    executionId: string;
    workflowId: string;
    status: string;
    startTime?: string;
    endTime?: string;
    definitionVersion?: number;
    definitionChangeset?: number;
    /** A cloud step fell back to this computer during the run. */
    degraded?: boolean;
  };
  logs: RunLog[];
}

export interface ExecutionInsight {
  executionId: string;
  workflowName?: string;
  parentExecutionId?: string;
  pendingActivities: {
    type?: string;
    attempt?: number;
    maximumAttempts?: number;
    state?: string;
    lastFailure?: string;
  }[];
  children: { executionId: string; runId?: string; status?: string; startTime?: string }[];
  whereabouts?: { runState: 'waiting' | 'running'; waitingOn?: { signalType?: string; until?: string }; atNode?: string };
}

export interface ExecutionSummary {
  executionId: string;
  workflowId: string;
  status: string;
  startTime?: string;
  /** A cloud step fell back to this computer during the run. */
  degraded?: boolean;
}

const TOKEN_KEY = 'metis-token';

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (token: string): void => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Shared by the uplift API module (uplift-api.ts); same bearer + error rules. */
export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as {
      error?: string;
      details?: string[];
    };
    // A dead session is a logged-out session: drop the token so the route
    // guard sends the next render to /login rather than looping on 401s.
    if (response.status === 401) clearToken();
    const base = detail.error ?? `request failed (${response.status})`;
    // Keep the reason (e.g. why a definition is invalid), not just the category.
    const message = detail.details?.length ? `${base}: ${detail.details.join('; ')}` : base;
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  async login(userId: string, secret: string): Promise<void> {
    const result = await request<{ token: string }>('POST', '/api/auth/login', {
      userId,
      secret,
    });
    setToken(result.token);
  },
  me: () => request<{ userId: string; role: string }>('GET', '/api/auth/me'),
  catalogue: () => request<{ entries: CatalogueEntry[] }>('GET', '/api/node-catalogue'),
  connectors: () => request<{ connectors: ConnectorDef[] }>('GET', '/api/connectors'),
  // Connections are named instances of a connector type.
  connections: () => request<{ connections: ConnectionRecord[] }>('GET', '/api/connections'),
  createConnection: (input: {
    name: string;
    connectorId: string;
    connectionType?: string;
    baseUrl?: string;
    authScheme?: string;
    material: Record<string, string>;
  }) => request<ConnectionRecord>('POST', '/api/connections', input),
  // One connection with its NON-SECRET values, for pre-filling the edit form.
  getConnection: (connectionId: string) =>
    request<{ connection: ConnectionRecord; values: Record<string, string> }>(
      'GET',
      `/api/connections/${encodeURIComponent(connectionId)}`,
    ),
  // Edit a connection: rename and/or rotate its credentials. Material is MERGED
  // (an absent field keeps its current value), so a blank secret is preserved.
  updateConnection: (
    connectionId: string,
    changes: { name?: string; material?: Record<string, string> },
  ) => request('PATCH', `/api/connections/${encodeURIComponent(connectionId)}`, changes),
  deleteConnection: (connectionId: string) =>
    request('DELETE', `/api/connections/${encodeURIComponent(connectionId)}`),
  testConnection: (connectionId: string) =>
    request<ConnectionHealth>('POST', `/api/connections/${encodeURIComponent(connectionId)}/test`),
  // Test raw material before saving (the create-connection modal).
  testConnectionMaterial: (input: {
    connectorId?: string;
    authScheme?: string;
    baseUrl?: string;
    material: Record<string, string>;
  }) => request<ConnectionHealth>('POST', '/api/connections/test', input),
  // The Data node's visual builder: a connection's live tables (locked when the
  // engine ships only in Helix, so the inspector falls back to a typed name).
  dataTables: (connectionId: string) =>
    request<{ engine: string; tables: { name: string; schema?: string }[]; locked?: boolean; error?: string }>(
      'GET',
      `/api/data/tables?connectionId=${encodeURIComponent(connectionId)}`,
    ),
  // Validate a SQL query against a connection (a describe, no rows pulled) and
  // get the columns it produces - which become the step's output variables.
  validateQuery: (connectionId: string, query: string, params?: unknown[]) =>
    request<{ engine: string; valid: boolean; columns?: { name: string; type?: string }[]; locked?: boolean; error?: string }>(
      'POST',
      '/api/data/validate',
      { connectionId, query, params },
    ),
  // A table's columns, for the visual builder (its output variables in build mode).
  dataColumns: (connectionId: string, table: string) =>
    request<{ engine: string; columns: { name: string; type?: string }[]; locked?: boolean; error?: string }>(
      'GET',
      `/api/data/tables/${encodeURIComponent(table)}/columns?connectionId=${encodeURIComponent(connectionId)}`,
    ),
  oauthCapable: () => request<{ connectors: string[] }>('GET', '/api/connectors/oauth-capable'),
  oauthStart: (connectorId: string) =>
    request<{ authorizeUrl: string }>(
      'GET',
      `/api/connectors/${encodeURIComponent(connectorId)}/oauth/start`,
    ),
  listWorkflows: () => request<{ items: WorkflowItem[] }>('GET', '/api/workflows?limit=50'),
  getWorkflow: (workflowId: string) =>
    request<WorkflowItem>('GET', `/api/workflows/${encodeURIComponent(workflowId)}`),
  createWorkflow: (name: string, nodes: WorkflowNode[], edges: WorkflowEdge[], cloudRouting?: CloudRouting) =>
    request<{ id: string }>('POST', '/api/workflows', { name, nodes, edges, cloudRouting }),
  updateWorkflow: (workflowId: string, nodes: WorkflowNode[], edges: WorkflowEdge[], name?: string, cloudRouting?: CloudRouting) =>
    request('PATCH', `/api/workflows/${encodeURIComponent(workflowId)}`, { name, nodes, edges, cloudRouting }),
  publishWorkflow: (workflowId: string) =>
    request('POST', `/api/workflows/${encodeURIComponent(workflowId)}/publish`),
  deleteWorkflow: (workflowId: string) =>
    request('DELETE', `/api/workflows/${encodeURIComponent(workflowId)}`),
  startExecution: (body: {
    workflowId?: string;
    definition?: { nodes: WorkflowNode[]; edges: WorkflowEdge[]; cloudRouting?: CloudRouting };
    input?: unknown;
    /** Consent for THIS run only ("Send to the cloud" without "don't ask again"). */
    cloudConsent?: boolean;
  }) =>
    request<{ executionId: string; runId?: string; status?: string }>(
      'POST',
      '/api/executions',
      body,
    ),
  temporalExecutions: (status?: string) => {
    const suffix = status ? '?status=' + encodeURIComponent(status) : '';
    return request<{ items: TemporalExecution[] }>('GET', `/api/executions/temporal${suffix}`);
  },
  // Mission control: status counts + worker/queue health.
  operateSummary: () =>
    request<{
      counts?: Record<string, number>;
      queue?: { taskQueue: string; pollers: { identity: string; lastAccessTime?: string }[] };
    }>('GET', '/api/operate/summary'),
  operateSchedules: () =>
    request<{
      items: {
        scheduleId: string;
        workflowId: string;
        workflowName?: string;
        paused: boolean;
        cron?: string;
        nextRun?: string;
        nextRuns?: string[];
      }[];
    }>('GET', '/api/operate/schedules'),
  pauseSchedule: (workflowId: string) =>
    request('POST', `/api/schedules/${encodeURIComponent(workflowId)}/pause`),
  resumeSchedule: (workflowId: string) =>
    request('POST', `/api/schedules/${encodeURIComponent(workflowId)}/unpause`),
  workflowVersions: (workflowId: string) =>
    request<{
      items: {
        version: number;
        changeset: number;
        status: string;
        name?: string;
        createdAt?: string;
        updatedAt?: string;
        steps: number;
      }[];
    }>('GET', `/api/workflows/${encodeURIComponent(workflowId)}/versions`),
  executionArchive: () =>
    request<{
      items: {
        executionId: string;
        workflowId: string;
        workflowName?: string;
        status: string;
        startTime?: string;
        endTime?: string;
        definitionVersion?: number;
        definitionChangeset?: number;
      }[];
      retentionDays: number;
    }>('GET', '/api/executions/archive'),
  executionInsight: (executionId: string) =>
    request<ExecutionInsight>('GET', `/api/executions/${encodeURIComponent(executionId)}/insight`),
  signalExecution: (executionId: string, signalType: string, signalParams?: unknown) =>
    request('POST', `/api/executions/${encodeURIComponent(executionId)}/signal`, { signalType, signalParams }),
  cancelExecution: (executionId: string, reason?: string) =>
    request('POST', `/api/executions/${encodeURIComponent(executionId)}/cancel`, { reason }),
  terminateExecution: (executionId: string, reason?: string) =>
    request('POST', `/api/executions/${encodeURIComponent(executionId)}/terminate`, { reason }),
  resetExecution: (executionId: string, reason?: string) =>
    request<{ runId: string }>('POST', `/api/executions/${encodeURIComponent(executionId)}/reset`, { reason }),
  allExecutions: () =>
    request<{ items: ExecutionSummary[] }>('GET', '/api/executions?limit=100'),
  workflowExecutions: (workflowId: string) =>
    request<{ items: ExecutionSummary[] }>(
      'GET',
      `/api/executions?workflowId=${encodeURIComponent(workflowId)}`,
    ),
  execution: (executionId: string) =>
    request<ExecutionDetail>('GET', `/api/executions/${encodeURIComponent(executionId)}`),
};
