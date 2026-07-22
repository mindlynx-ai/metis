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
 * Thin HTTP client for driving a live `metis up` runtime from the system
 * suite: login, request helper, workflow/execution builders, and a poller
 * that runs an inline definition and waits for the terminal state. Node ids
 * are real UUIDs so parameter-substitution tokens resolve.
 */
import { randomUUID } from 'node:crypto';

export const BASE = process.env.METIS_URL ?? 'http://localhost:3000';
export const ADMIN_USER = process.env.METIS_ADMIN_USER ?? 'admin';
export const ADMIN_SECRET = process.env.METIS_ADMIN_SECRET ?? 'metis';

/** True when a runtime answers on BASE, so the suite can skip when it is down. */
export async function runtimeUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: ADMIN_USER, secret: ADMIN_SECRET }),
      signal: AbortSignal.timeout(2500),
    });
    return res.status === 200 || res.status === 401;
  } catch {
    return false;
  }
}

export interface Reply<T = unknown> {
  status: number;
  body: T;
}

export async function login(userId = ADMIN_USER, secret = ADMIN_SECRET): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, secret }),
  });
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error(`login failed (${res.status})`);
  return body.token;
}

export function client(token?: string) {
  return async <T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Reply<T>> => {
    // Only set content-type when there IS a body: Fastify rejects a bodyless
    // POST/DELETE (publish, delete, cancel) that declares application/json.
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T };
  };
}

export const nodeId = (): string => `node-${randomUUID()}`;

export interface FixtureNode {
  id: string;
  type: string;
  version?: string;
  data: { label: string; config: Record<string, unknown> };
}

export const node = (
  id: string,
  type: string,
  config: Record<string, unknown>,
  label = type,
): FixtureNode => ({ id, type, version: 'v1', data: { label, config } });

export const edge = (source: string, target: string) => ({
  id: `${source}->${target}`,
  source,
  target,
  sourceHandle: null,
});

export interface RunLog {
  nodeId?: string;
  nodeType?: string;
  event?: string;
  outcome?: string;
  output?: unknown;
  error?: unknown;
}

/** The last completed/failed log line for a node id (its result). */
export function nodeResult(logs: RunLog[], id: string): RunLog | undefined {
  return logs.filter((l) => l.nodeId === id && l.outcome).at(-1);
}

/**
 * Start an inline definition and poll until it leaves `running`. Requires a
 * workflowId (any created one); the inline definition is what actually runs,
 * so publish is not needed and start-level validation applies (>=1 node, one
 * start, no dangling edges, no trigger-entry requirement).
 */
export async function runInline(
  api: ReturnType<typeof client>,
  workflowId: string,
  nodes: FixtureNode[],
  edges: ReturnType<typeof edge>[] = [],
  input: Record<string, unknown> = {},
): Promise<{ status: string; logs: RunLog[]; executionId: string }> {
  const started = await api<{ executionId: string }>('POST', '/api/executions', {
    workflowId,
    definition: { nodes, edges },
    input,
  });
  if (started.status !== 202) {
    throw new Error(`start failed ${started.status}: ${JSON.stringify(started.body)}`);
  }
  const executionId = started.body.executionId;
  for (let i = 0; i < 40; i += 1) {
    const detail = await api<{ meta: { status: string }; logs: RunLog[] }>(
      'GET',
      `/api/executions/${encodeURIComponent(executionId)}`,
    );
    const status = detail.body?.meta?.status;
    if (status && status !== 'running') {
      return { status, logs: detail.body.logs ?? [], executionId };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`execution ${executionId} did not settle in time`);
}
