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
 * Shared fixtures for the e-commerce acceptance suite: node builders that
 * point at the fake outside world, the per-node run policy (retries, backoff,
 * timeout, onFailure) the harness shape does not carry, and run helpers for
 * scenarios that park mid-flight instead of settling inside runInline's poll.
 *
 * Test case ids (TC01.1 and friends) come from the e-commerce acceptance
 * spec: 10 use cases, 50 cases, P0 blocks release.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { client, edge, node, nodeId, type FixtureNode, type RunLog } from '../harness.js';
import type { Externals } from './externals.js';

const exec = promisify(execFile);

export interface NodePolicy {
  retries?: number;
  backoffSeconds?: number;
  timeoutSeconds?: number;
  onFailure?: 'halt' | 'continue';
  idempotencyKey?: string;
}

export interface PolicyNode extends FixtureNode {
  data: FixtureNode['data'] & { policy?: NodePolicy };
}

/** Attach the inspector's Policy tab settings to a node. */
export function withPolicy(target: FixtureNode, policy: NodePolicy): PolicyNode {
  return { ...target, data: { ...target.data, policy } };
}

/** A step that calls the outside world (payment, courier, channel, Slack, mail). */
export function callNode(
  externals: Externals,
  path: string,
  options: {
    label?: string;
    method?: string;
    body?: unknown;
    timeoutMs?: number;
    headers?: Record<string, string>;
    id?: string;
  } = {},
): FixtureNode {
  return node(
    options.id ?? nodeId(),
    'http',
    {
      url: `${externals.baseUrl}${path}`,
      method: options.method ?? 'POST',
      body: options.body ?? {},
      headers: options.headers,
      // The operator registration decision: this host is deliberately reachable.
      allowedHosts: [externals.host],
      timeout: options.timeoutMs ?? 5000,
    },
    options.label ?? path,
  );
}

/** A local step: pure logic, no network. */
export function step(code: string, label = 'step', id = nodeId()): FixtureNode {
  return node(id, 'code', { code }, label);
}

/** Branch on an upstream value: `switchOptions[i].id` names the branch handle. */
export function branch(
  options: { id: string; property: string; checkValue: unknown; checkOperator?: string }[],
  label = 'decide',
  id = nodeId(),
): FixtureNode {
  return node(
    id,
    'switch',
    {
      switchOptions: options.map((o) => ({
        id: o.id,
        conditions: [
          { property: o.property, checkValue: o.checkValue, checkOperator: o.checkOperator ?? '===' },
        ],
      })),
    },
    label,
  );
}

/** Wait a real, durable interval (the multi-day cases scale this down). */
export function wait(seconds: number, label = 'wait', id = nodeId()): FixtureNode {
  return node(id, 'waituntil', { waitSeconds: seconds }, label);
}

/** Park until a named signal arrives (restock, dispatch, item received). */
export function awaitSignal(
  signalType: string,
  options: { label?: string; id?: string; timeoutMs?: number } = {},
): FixtureNode {
  return node(
    options.id ?? nodeId(),
    'signal',
    { signalType, timeoutMs: options.timeoutMs },
    options.label ?? signalType,
  );
}

/** The deliberate kill switch behind a guard branch. */
export function stop(message: string, label = 'halt', id = nodeId()): FixtureNode {
  return node(id, 'stopanderror', { message }, label);
}

export { edge, node, nodeId };

export type Api = ReturnType<typeof client>;

/** Start a run and return immediately: for flows that park rather than settle. */
export async function startRun(
  api: Api,
  workflowId: string,
  nodes: FixtureNode[],
  edges: ReturnType<typeof edge>[] = [],
  input: Record<string, unknown> = {},
): Promise<string> {
  const started = await api<{ executionId: string }>('POST', '/api/executions', {
    workflowId,
    definition: { nodes, edges },
    input,
  });
  if (started.status !== 202) {
    throw new Error(`start failed ${started.status}: ${JSON.stringify(started.body)}`);
  }
  return started.body.executionId;
}

export interface RunDetail {
  meta: { status: string; startedAt?: string; endedAt?: string };
  logs: RunLog[];
}

export async function detail(api: Api, executionId: string): Promise<RunDetail> {
  const res = await api<RunDetail>('GET', `/api/executions/${encodeURIComponent(executionId)}`);
  return res.body;
}

export interface ExecutionSummary {
  executionId: string;
  workflowId?: string;
  status?: string;
}

/** The runs list. The API answers under `items`; `executions` is tolerated so
 *  a shape change cannot silently turn these reads into empty arrays. */
export async function listExecutions(api: Api, limit = 50): Promise<ExecutionSummary[]> {
  const res = await api<{ items?: ExecutionSummary[]; executions?: ExecutionSummary[] }>(
    'GET',
    `/api/executions?limit=${limit}`,
  );
  return res.body.items ?? res.body.executions ?? [];
}

/** Cancel anything a failed case left parked, so the next file starts clean. */
export async function cancelStragglers(api: Api): Promise<void> {
  for (const e of await listExecutions(api)) {
    if (e.status === 'running') await cancelRun(api, e.executionId, 'ecommerce suite cleanup');
  }
}

/** Poll a run until `done` says so. Throws with the last state on timeout. */
export async function until(
  api: Api,
  executionId: string,
  done: (d: RunDetail) => boolean,
  timeoutMs = 30000,
): Promise<RunDetail> {
  const deadline = Date.now() + timeoutMs;
  let last: RunDetail | undefined;
  while (Date.now() < deadline) {
    last = await detail(api, executionId);
    // The execution record lands a beat after the 202, so an answer without
    // meta means "not yet", never a crash.
    if (last?.meta && done(last)) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `execution ${executionId} never satisfied the predicate; last status ${last?.meta?.status}`,
  );
}

export const settled = (d: RunDetail): boolean => d.meta.status !== 'running';

/** True once a node has reached a terminal outcome in the run log. */
export const nodeDone = (id: string) => (d: RunDetail) =>
  (d.logs ?? []).some((l) => l.nodeId === id && Boolean(l.outcome));

/** True once a node has started. */
export const nodeStarted = (id: string) => (d: RunDetail) =>
  (d.logs ?? []).some((l) => l.nodeId === id && l.event === 'workflow.node.started');

/** True once a node is parked on an outside event: a signal node logs
 *  `workflow.node.waiting`, never `started`, while it holds the run. */
export const nodeWaiting = (id: string) => (d: RunDetail) =>
  (d.logs ?? []).some((l) => l.nodeId === id && l.event === 'workflow.node.waiting');

export function outcomeOf(logs: RunLog[], id: string): string | undefined {
  return logs.filter((l) => l.nodeId === id && l.outcome).at(-1)?.outcome;
}

export function outputOf(logs: RunLog[], id: string): Record<string, unknown> | undefined {
  const last = logs.filter((l) => l.nodeId === id && l.outcome).at(-1);
  return last?.output as Record<string, unknown> | undefined;
}

/** How many times a node ran: the audit question every retry case asks. */
export function startCount(logs: RunLog[], id: string): number {
  return logs.filter((l) => l.nodeId === id && l.event === 'workflow.node.started').length;
}

export async function sendSignal(
  api: Api,
  executionId: string,
  signalType: string,
  signalParams: Record<string, unknown> = {},
): Promise<number> {
  const res = await api('POST', `/api/executions/${encodeURIComponent(executionId)}/signal`, {
    signalType,
    signalParams,
  });
  return res.status;
}

export async function cancelRun(api: Api, executionId: string, reason = 'test'): Promise<number> {
  const res = await api('POST', `/api/executions/${encodeURIComponent(executionId)}/cancel`, { reason });
  return res.status;
}

/**
 * Restart the runtime mid-run: the multi-day cases (TC01.5, TC04.3, TC05.5)
 * are only meaningful if the process actually dies. Defaults to the compose
 * quickstart; override with METIS_RESTART_CMD.
 */
export async function restartRuntime(): Promise<void> {
  const cmd = process.env.METIS_RESTART_CMD ?? 'docker compose -f compose/docker-compose.yml restart metis';
  const [bin, ...args] = cmd.split(' ');
  await exec(bin, args, { cwd: process.cwd() });
}

/** Wait for the runtime to answer again after a restart. */
export async function runtimeBack(base: string, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'nobody', secret: 'nobody' }),
        signal: AbortSignal.timeout(2000),
      });
      if (res.status === 200 || res.status === 401) return;
    } catch {
      // still down
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`runtime at ${base} did not come back`);
}
