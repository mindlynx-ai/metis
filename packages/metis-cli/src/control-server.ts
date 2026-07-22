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
import { join, extname } from 'node:path';
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

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
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

  const app = buildCoreServer({
    identity,
    store: runtime.store,
    executions,
    credentials: runtime.credentials,
    connectionTester: new DefaultConnectionTester(),
    dataSources: buildDataSources(),
    schedules: scheduleService,
    uplift: buildUpliftDeps(runtime),
    // Binding a trigger: store the record, and for a schedule also provision
    // the Temporal Schedule now so it fires without waiting for the next boot.
    triggers: {
      list: () => runtime.triggers.list() as unknown as Promise<Record<string, unknown>[]>,
      create: async (input) => {
        const record = await runtime.triggers.create(input as Parameters<typeof runtime.triggers.create>[0]);
        if (record.kind === 'schedule' && record.cron) {
          await scheduleService.create(TENANT, record.workflowId, record.cron);
        }
        return record as unknown as Record<string, unknown>;
      },
      remove: async (triggerId) => {
        const record = await runtime.triggers.get(triggerId);
        await runtime.triggers.remove(triggerId);
        if (record?.kind === 'schedule') {
          await scheduleService.remove(TENANT, record.workflowId).catch(() => undefined);
        }
      },
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
      const candidate = url ? join(editorDir, url) : join(editorDir, 'index.html');
      const filePath =
        existsSync(candidate) && extname(candidate) ? candidate : join(editorDir, 'index.html');
      const body = await readFile(filePath);
      return reply
        .header('content-type', CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream')
        .send(body);
    });
  }

  await app.ready();
  attachSocketHub(app.server, { identity, bus: runtime.bus });
  return app;
}
