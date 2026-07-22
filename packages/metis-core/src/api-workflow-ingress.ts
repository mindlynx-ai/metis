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
 * API-workflow ingress (the live half of API Start / API End): match an
 * inbound request path to a published api-type workflow by its API Start
 * `path`, run helixApiWorkflow SYNCHRONOUSLY, and return API End's body as the
 * HTTP response. Pure and transport-free so the route is a thin adapter and the
 * whole path is unit-testable. Path/method matching is exact-string (a "dumb
 * router", Helix-parity) - a single wildcard route does a lookup rather than
 * registering a Fastify route per workflow.
 */
import type { FastifyInstance } from 'fastify';
import type { ExecutionPort } from '@mindlynx/metis-ports';
import type { WorkflowStore, WorkflowVersionItem } from '@mindlynx/metis-data-gateway';
import type { WorkflowDefinition } from '@mindlynx/metis-engine';

const DEFAULT_WAIT_MS = 120_000;

type HeaderBag = Record<string, string | string[] | undefined>;

interface StoredNode {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  data?: { config?: Record<string, unknown> };
}

/** Drop leading/trailing slashes so "/orders" and "orders" match (linear). */
function normalisePath(path: string): string {
  let start = 0;
  let end = path.length;
  while (start < end && path[start] === '/') start += 1;
  while (end > start && path[end - 1] === '/') end -= 1;
  return path.slice(start, end);
}

function configOf(node: StoredNode): Record<string, unknown> {
  return node.config ?? node.data?.config ?? {};
}

function methodMatches(configured: unknown, wanted: string): boolean {
  const method = String(configured ?? '').toUpperCase();
  return method === '' || method === 'ANY' || method === wanted.toUpperCase();
}

/**
 * The published api-type workflow whose API Start path (+ method) matches, or
 * undefined. listWorkflows returns newest-first, so the first match is the
 * latest published version.
 */
export async function findPublishedApiWorkflow(
  store: WorkflowStore,
  tenantId: string,
  path: string,
  method: string,
): Promise<WorkflowVersionItem | undefined> {
  const { items } = await store.listWorkflows(tenantId, { status: 'published', limit: 100 });
  const wantPath = normalisePath(path);
  for (const item of items) {
    if (item.type !== 'api') continue;
    const nodes = ((item.definition as { nodes?: StoredNode[] }).nodes ?? []) as StoredNode[];
    const apiStart = nodes.find((node) => node.type.toLowerCase() === 'apiconfig');
    if (!apiStart) continue;
    const config = configOf(apiStart);
    if (normalisePath(String(config.path ?? '')) === wantPath && methodMatches(config.method, method)) {
      return item;
    }
  }
  return undefined;
}

export interface ApiWorkflowDeps {
  store: WorkflowStore;
  executions: ExecutionPort;
  tenantId: string;
  newExecutionId: () => string;
  waitMs?: number;
}

export interface ApiWorkflowArgs {
  path: string;
  method: string;
  body: unknown;
  headers: HeaderBag;
}

export interface ApiWorkflowResult {
  httpStatus: number;
  body: unknown;
}

/** Resolve, run synchronously, and map the outcome to an HTTP response. */
export async function handleApiWorkflow(
  deps: ApiWorkflowDeps,
  args: ApiWorkflowArgs,
): Promise<ApiWorkflowResult> {
  if (!deps.executions.startApiAndWait) {
    return { httpStatus: 501, body: { error: 'api workflows are not available here' } };
  }
  const match = await findPublishedApiWorkflow(deps.store, deps.tenantId, args.path, args.method);
  if (!match) {
    return {
      httpStatus: 404,
      body: { error: `no api workflow for ${args.method.toUpperCase()} /${normalisePath(args.path)}` },
    };
  }
  // The request body becomes the run input, seeded onto the API Start node so
  // {{node-<apiStart>.data.*}} resolves to what the caller sent.
  const input =
    args.body && typeof args.body === 'object' && !Array.isArray(args.body)
      ? (args.body as Record<string, unknown>)
      : { value: args.body };

  const executionId = deps.newExecutionId();
  const run = await deps.executions.startApiAndWait(
    {
      tenantId: deps.tenantId,
      workflowId: match.workflowId,
      executionId,
      workflowType: 'helixApiWorkflow',
      definition: match.definition as unknown as WorkflowDefinition,
      input,
    } as never,
    deps.waitMs ?? DEFAULT_WAIT_MS,
  );

  if (run.timedOut) return { httpStatus: 504, body: { error: 'api workflow timed out' } };
  if (run.status !== 'completed') {
    return { httpStatus: 500, body: { error: 'api workflow failed', executionId } };
  }
  return { httpStatus: run.statusCode ?? 200, body: run.response ?? null };
}

/**
 * Mount the single wildcard ingress route. Authed for v1 (the session gives
 * the tenant); public per-endpoint keys are a follow-up.
 */
export function registerApiWorkflowRoute(
  app: FastifyInstance,
  deps: Omit<ApiWorkflowDeps, 'tenantId'> & { tenantOf: (request: unknown) => string },
): void {
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/api/apiworkflow/*',
    handler: async (request, reply) => {
      const path = (request.params as { '*': string })['*'] ?? '';
      const result = await handleApiWorkflow(
        {
          store: deps.store,
          executions: deps.executions,
          tenantId: deps.tenantOf(request),
          newExecutionId: deps.newExecutionId,
          waitMs: deps.waitMs,
        },
        { path, method: request.method, body: request.body ?? {}, headers: request.headers },
      );
      return reply.code(result.httpStatus).send(result.body);
    },
  });
}
