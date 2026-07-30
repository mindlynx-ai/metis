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
 * The single control-plane server for `metis up`. The laptop
 * shape collapses core and orchestrator into one process: metis-core
 * serves auth, entitlements, catalogue, definition CRUD, execution
 * reads and (given an ExecutionPort) execution lifecycle; the run-
 * status WebSocket is attached from the shared event bus; and, when a
 * build is present, the editor static bundle is served so the whole
 * product is one origin.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { attachSocketHub, handleWebhook, type TriggerService } from '@mindlynx/metis-orchestrator';
import { TemporalExecutionAdapter } from '@mindlynx/metis-orchestrator';
import {
  CloudEntitlementsClient,
  OffersClient,
  helixAccountBearer,
  type ExecutionPort,
} from '@mindlynx/metis-ports';
import type { WorkflowStore } from '@mindlynx/metis-data-gateway';
import { buildCoreServer, type UpliftDeps } from '@mindlynx/metis-core';
import { ScheduleService } from '@mindlynx/metis-orchestrator';
import { DefaultConnectionTester, buildDataSources } from '@mindlynx/metis-nodes';
import { METIS_TASK_QUEUE } from '@mindlynx/metis-engine';
import { TENANT, type MetisRuntime } from './runtime.js';

export interface WebhookRouteDeps {
  triggers: TriggerService;
  store: WorkflowStore;
  executions: ExecutionPort;
  tenantId: string;
  newExecutionId?: () => string;
  now?: () => string;
}

/**
 * Mount the unauthenticated webhook ingress (POST /hooks/:triggerId) in
 * its own encapsulated scope so raw-body parsing does not leak onto the
 * JSON API. External providers post here; the handler verifies and
 * starts the bound workflow.
 */
export async function registerWebhookRoute(
  app: FastifyInstance,
  deps: WebhookRouteDeps,
): Promise<void> {
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body);
    });
    scope.post('/hooks/:triggerId', async (request, reply) => {
      const { triggerId } = request.params as { triggerId: string };
      const rawBody = typeof request.body === 'string' ? request.body : '';
      const result = await handleWebhook(
        {
          triggers: deps.triggers,
          store: deps.store,
          executions: deps.executions,
          tenantId: deps.tenantId,
          newExecutionId: deps.newExecutionId ?? (() => `exec_${randomUUID()}`),
          now: deps.now ?? (() => new Date().toISOString()),
        },
        { triggerId, rawBody, headers: request.headers },
      );
      return reply
        .code(result.status)
        .send(result.executionId ? { executionId: result.executionId } : { error: result.error });
    });
  });
}

/**
 * What a static request resolves to: a file, or nothing.
 *
 * A path with an extension is asking for a FILE, so a missing one is a 404.
 * Serving index.html instead made every URL on the origin answer 200 with
 * identical HTML: /robots.txt came back as text/html, and so did any path at
 * all, including ones nobody could have meant. To a reputation scanner an
 * origin with no 404 anywhere looks like a doorway or cloaking page, and it
 * hides genuinely broken asset links from us too.
 *
 * Extension-less paths still fall through to the shell, because those are the
 * client-side routes the editor owns.
 *
 * CONTAINMENT IS THE POINT. This route is mounted on the root app, outside the
 * bearer-gated scope, so whatever it returns it returns to anyone who can reach
 * the port. `join` normalises `..` away rather than rejecting it, and Fastify's
 * router hands us the path already percent-decoded (`%2f` arrives as `/`), so
 * `/..%2f..%2f.metis%2fcredential.key` used to resolve to the encryption key
 * sitting beside the credential vault, and `.key`/`.enc`/`.db` all carry an
 * extension so none of them were rerouted to the shell. Every candidate is now
 * resolved and required to sit under the resolved editor directory; the prefix
 * test includes the separator so a sibling directory whose name merely starts
 * with the same characters cannot pass.
 *
 * Pure, with the existence check injected, so the rule can be tested without a
 * server or a filesystem.
 */
export function resolveStaticTarget(
  editorDir: string,
  url: string,
  exists: (path: string) => boolean,
): { file: string; notFound?: false } | { notFound: true; file?: undefined } {
  const shell = join(editorDir, 'index.html');
  const base = resolve(editorDir);
  const contained = (candidate: string): boolean =>
    candidate === base || candidate.startsWith(`${base}${sep}`);
  // An unmatched /api path is a missing endpoint, never a client route. Falling
  // through to the shell answered 200 text/html to a caller expecting JSON,
  // which reads as success: a client that does not check the content type sees
  // a live endpoint where there is none, and an operator debugging a 404 is
  // shown a page instead. GET was the only method affected, so the same absent
  // route answered 404 to POST and 200 to GET.
  // The wildcard route hands this the path with no leading slash, but accept
  // both spellings so a caller that passes the raw URL is not silently missed.
  const path = url.startsWith('/') ? url.slice(1) : url;
  if (path === 'api' || path.startsWith('api/')) return { notFound: true };
  if (!url) return { file: shell };
  const candidate = resolve(editorDir, url);
  // Checked before the extension test, so an escaping path is refused outright
  // rather than falling through to the shell and answering 200 for a traversal
  // attempt: a 404 tells a prober nothing about what is up there.
  if (!contained(candidate)) return { notFound: true };
  if (!extname(candidate)) return { file: shell };
  return exists(candidate) ? { file: candidate } : { notFound: true };
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  // robots.txt served as application/octet-stream is a file a crawler may
  // decline to read, which would waste the point of shipping one.
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface ControlServerOptions {
  runtime: MetisRuntime;
  editorDir?: string;
}

/**
 * The uplift surface, from the same two env vars the worker's resolver
 * reads. Both unset = the kill switch (no account routes, static offers,
 * nothing cloud). METIS_HELIX_REDIRECT_BASE overrides where the OIDC
 * callback lands (defaults to the editor dev origin).
 */
function buildUpliftDeps(runtime: MetisRuntime): UpliftDeps | undefined {
  const gatewayUrl = process.env.METIS_HELIX_GATEWAY_URL;
  const identityUrl = process.env.METIS_HELIX_IDENTITY_URL ?? gatewayUrl;
  if (!gatewayUrl || !identityUrl) return undefined;
  // The OIDC client this instance authenticates as (defaults to the
  // realm-as-code client 'metis-editor'; override for a differently-named realm).
  const clientId = process.env.METIS_HELIX_CLIENT_ID ?? 'metis-editor';
  // Rotation-safe bearer: the token endpoint comes from the identity
  // provider's discovery document, resolved lazily and cached.
  const getBearer = helixAccountBearer(runtime.credentials, TENANT, { identityUrl, clientId });
  return {
    offers: new OffersClient({ baseUrl: gatewayUrl }),
    entitlements: new CloudEntitlementsClient({ baseUrl: gatewayUrl, getBearer }),
    credentials: runtime.credentials,
    identityUrl,
    redirectBase: process.env.METIS_HELIX_REDIRECT_BASE ?? 'http://127.0.0.1:4180',
    clientId,
  };
}

export async function buildControlServer(options: ControlServerOptions): Promise<FastifyInstance> {
  const { runtime } = options;
  const identity = await runtime.identity;
  const executions = new TemporalExecutionAdapter({
    address: runtime.address,
    taskQueue: METIS_TASK_QUEUE,
  });

  // One ScheduleService, shared by the Operate panel and trigger provisioning
  // (lazy self-healing client; cheap to build).
  const scheduleService = new ScheduleService(runtime.store, {
    address: runtime.address,
    taskQueue: METIS_TASK_QUEUE,
  });

  // One registry, shared: the table browser dispatches through it and the
  // connection test proves a data engine by querying it through the same
  // adapter the workflow will use.
  const dataSources = buildDataSources();
  const app = buildCoreServer({
    identity,
    store: runtime.store,
    executions,
    credentials: runtime.credentials,
    audit: runtime.audit,
    connectionTester: new DefaultConnectionTester(dataSources),
    dataSources,
    schedules: scheduleService,
    uplift: buildUpliftDeps(runtime),
    // Binding a trigger: store the record, and for a schedule also provision
    // the Temporal Schedule now so it fires without waiting for the next boot.
    triggers: {
      list: () => runtime.triggers.list() as unknown as Promise<Record<string, unknown>[]>,
      create: async (input) => {
        // Provision the Temporal Schedule BEFORE storing the record. The
        // schedule is the thing that actually fires, so if it cannot be
        // created (one already exists, bad cron, Temporal down) the caller
        // gets the error and no trigger row is left behind listing as live.
        const wanted = input as { kind?: string; cron?: string; workflowId?: string };
        if (wanted.kind === 'schedule' && wanted.cron && wanted.workflowId) {
          await scheduleService.create(TENANT, wanted.workflowId, wanted.cron);
        }
        const record = await runtime.triggers.create(input as Parameters<typeof runtime.triggers.create>[0]);
        return record as unknown as Record<string, unknown>;
      },
      remove: async (triggerId) => {
        const record = await runtime.triggers.get(triggerId);
        await runtime.triggers.remove(triggerId);
        if (record?.kind === 'schedule') {
          await scheduleService.remove(TENANT, record.workflowId).catch(() => undefined);
        }
      },
      setSecret: (triggerId, secret) => runtime.triggers.setSecret(triggerId, secret),
    },
  });

  await registerWebhookRoute(app, {
    triggers: runtime.triggers,
    store: runtime.store,
    executions,
    tenantId: TENANT,
  });

  if (options.editorDir && existsSync(join(options.editorDir, 'index.html'))) {
    const editorDir = options.editorDir;
    app.get('/*', async (request, reply) => {
      const url = (request.params as { '*': string })['*'];
      const target = resolveStaticTarget(editorDir, url, existsSync);
      if (target.notFound) {
        return reply.code(404).header('content-type', 'text/plain; charset=utf-8').send('Not found');
      }
      const body = await readFile(target.file);
      return reply
        .header('content-type', CONTENT_TYPES[extname(target.file)] ?? 'application/octet-stream')
        .send(body);
    });
  }

  await app.ready();
  attachSocketHub(app.server, { identity, bus: runtime.bus });
  return app;
}
