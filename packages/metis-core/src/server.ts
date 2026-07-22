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
 * metis-core: the deliberately tiny control surface.
 * Single-tenant login with simple roles through the IdentityPort,
 * bearer sessions, per-route action gating (view vs edit vs admin),
 * and the entitlements shim. Definition CRUD attaches in the next
 * seam; almost all of helix-core stays behind.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IdentityPort, Session } from '@mindlynx/metis-ports';
import type { WorkflowStore } from '@mindlynx/metis-data-gateway';
import type {
  ConnectionTester,
  ConnectorCredentialStore,
  DataSourceRegistry,
  ExecutionPort,
} from '@mindlynx/metis-ports';
import { getCatalogue, listAllConnectors } from '@mindlynx/metis-catalogue';
import { EntitlementsShim } from './entitlements.js';
import { registerWorkflowRoutes } from './workflow-routes.js';
import { registerExecutionReadRoutes } from './execution-read-routes.js';
import { registerExecutionLifecycleRoutes } from './execution-lifecycle-routes.js';
import { registerApiWorkflowRoute } from './api-workflow-ingress.js';
import { registerConnectionRoutes } from './connection-routes.js';
import { registerDataResourceRoutes } from './data-resource-routes.js';
import { registerScheduleRoutes, type SchedulesLike } from './schedule-routes.js';
import { registerTriggerMgmtRoutes, type TriggersPort } from './trigger-mgmt-routes.js';
import { registerOAuthAuthedRoutes, registerOAuthCallback } from './oauth-routes.js';
import { defaultOAuthConfig, OAuthStateStore, type OAuthConfig } from './oauth.js';
import {
  ConnectStateStore,
  registerAccountCallback,
  registerAccountRoutes,
  STATIC_OFFERS,
  type UpliftDeps,
} from './helix-account-routes.js';

/** IdentityPort plus token issuance (the open default adapter has it). */
export interface TokenIssuingIdentity extends IdentityPort {
  issueToken(session: Session): string;
}

export interface CoreDependencies {
  identity: TokenIssuingIdentity;
  entitlements?: EntitlementsShim;
  store?: WorkflowStore;
  /** When supplied, metis-core drives executions directly (laptop shape). */
  executions?: ExecutionPort;
  /** When supplied, the connector connection routes (store credentials) mount. */
  credentials?: ConnectorCredentialStore;
  /** When supplied, connections can be health-tested (observability). */
  connectionTester?: ConnectionTester;
  /** When supplied, the Data node's visual builder can list a connection's
   *  tables/columns through the DataSourcePort (postgres in the open build). */
  dataSources?: DataSourceRegistry;
  /** When supplied, Operate can list/pause/resume Temporal Schedules.
   *  Structural (no orchestrator dependency): ScheduleService satisfies it. */
  schedules?: SchedulesLike;
  /** When supplied, workflows can be bound to webhook/schedule/poll triggers.
   *  Structural (no orchestrator import); the runtime supplies it. */
  triggers?: TriggersPort;
  /** OAuth provider config; defaults to well-known providers + env clients. */
  oauth?: OAuthConfig;
  /** The Helix uplift surface (offers/entitlements/account-connect).
   *  Absent = the kill switch: no account routes, static offers, no cloud. */
  uplift?: UpliftDeps;
}

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
  }
}

const loginBody = z.object({ userId: z.string().min(1), secret: z.string().min(1) });

export function buildCoreServer(deps: CoreDependencies): FastifyInstance {
  const app = Fastify({ logger: false });
  const entitlements = deps.entitlements ?? new EntitlementsShim();
  (app as unknown as { metisIdentity: IdentityPort }).metisIdentity = deps.identity;

  // OAuth config + shared state store; the callback is public (state-authed).
  const oauthConfig = deps.oauth ?? defaultOAuthConfig();
  const oauthState = new OAuthStateStore();
  if (deps.credentials) {
    registerOAuthCallback(app, deps.credentials, oauthConfig, oauthState);
  }

  // The Helix account-connect callback is public too (state-authed, PKCE).
  const accountStates = new ConnectStateStore();
  if (deps.uplift) {
    registerAccountCallback(app, deps.uplift, accountStates);
  }

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'userId and secret are required' });
    const session = await deps.identity.authenticate(parsed.data.userId, parsed.data.secret);
    if (!session) return reply.code(401).send({ error: 'invalid credentials' });
    const token = deps.identity.issueToken(session);
    return reply.send({ token, session });
  });

  app.register(async (authed) => {
    authed.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      const header = request.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
      const session = token ? await deps.identity.verify(token) : undefined;
      if (!session) {
        await reply.code(401).send({ error: 'unauthorised' });
        return reply;
      }
      request.session = session;
    });

    authed.get('/api/auth/me', async (request, reply) => reply.send(request.session));

    // The shim's open set, now with the cloud view: the account's capability
    // ids (empty unless connected and entitled) and whether the cloud is
    // reachable at all. 'disabled' = the kill switch (no uplift config).
    authed.get('/api/entitlements', async (_request, reply) => {
      const base = entitlements.report();
      if (!deps.uplift) {
        return reply.send({ ...base, capabilities: [], account: null, cloud: 'disabled' });
      }
      let cloud: 'ok' | 'offline' = 'ok';
      try {
        await deps.uplift.offers.offers();
      } catch {
        cloud = 'offline';
      }
      const capabilities = [...(await deps.uplift.entitlements.capabilities())];
      const account = (await deps.uplift.entitlements.account()) ?? null;
      return reply.send({ ...base, capabilities, account, cloud });
    });

    // Offers always answer (UPL palette + account page need them even
    // air-gapped): live manifest when reachable, the static view otherwise.
    // The live fetch is anonymous - no bearer, no per-user data, ever.
    authed.get('/api/offers', async (_request, reply) => {
      if (deps.uplift) {
        try {
          return reply.send({ capabilities: await deps.uplift.offers.offers(), source: 'live' });
        } catch {
          // fall through to static
        }
      }
      return reply.send({ capabilities: STATIC_OFFERS, source: 'static' });
    });

    if (deps.uplift) {
      registerAccountRoutes(authed, deps.uplift, accountStates);
    }

    // The laptop shape collapses core and orchestrator into one
    // process (brief section 3), so core serves the open catalogue to
    // the editor; the orchestrator owns it at scale.
    authed.get('/api/node-catalogue', async (_request, reply) => reply.send(getCatalogue()));

    // The connector catalogue (the 100 integrations + their operations) so the
    // connector node's picker can browse and pick one.
    authed.get('/api/connectors', async (_request, reply) => {
      const connectors = listAllConnectors();
      return reply.send({ schemaVersion: '1', count: connectors.length, connectors });
    });

    if (deps.credentials) {
      registerConnectionRoutes(authed, deps.credentials, deps.connectionTester);
      registerOAuthAuthedRoutes(authed, oauthConfig, oauthState);
      if (deps.dataSources) {
        registerDataResourceRoutes(authed, deps.credentials, deps.dataSources);
      }
    }

    if (deps.schedules) {
      registerScheduleRoutes(authed, deps.schedules, deps.store);
    }

    if (deps.triggers) {
      registerTriggerMgmtRoutes(authed, deps.triggers);
    }

    if (deps.store) {
      registerWorkflowRoutes(authed, deps.store, deps.triggers);
      registerExecutionReadRoutes(authed, deps.store);
      if (deps.executions) {
        registerExecutionLifecycleRoutes(authed, deps.store, deps.executions);
        // A published api-type workflow becomes a callable synchronous endpoint
        // at /api/apiworkflow/<its API Start path>.
        registerApiWorkflowRoute(authed, {
          store: deps.store,
          executions: deps.executions,
          newExecutionId: () => `exec_${randomUUID()}`,
          // Routes here are auth-gated, so a session always exists; fail loud
          // rather than defaulting the tenant if that invariant ever breaks.
          tenantOf: (request) => {
            const tenantId = (request as { session?: Session }).session?.tenantId;
            if (!tenantId) throw new Error('api workflow route reached without a session');
            return tenantId;
          },
        });
      }
    }
  });

  return app;
}
