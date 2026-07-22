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
 * OAuth2 authorization-code routes. Start is authenticated (edit) and returns
 * the provider authorize URL with an opaque state carrying the tenant + target
 * connector. The callback is a public browser redirect validated only by that
 * state (no bearer on a top-level navigation): it exchanges the code for tokens
 * and stores them as the connection, then redirects back to the editor.
 */
import type { FastifyInstance } from 'fastify';
import type { ConnectorCredentialStore, Session } from '@mindlynx/metis-ports';
import { requireAction } from './auth-gate.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  isOAuthCapable,
  type OAuthConfig,
  type OAuthStateStore,
} from './oauth.js';

/** The authenticated OAuth routes (edit): capability + start. */
export function registerOAuthAuthedRoutes(
  app: FastifyInstance,
  config: OAuthConfig,
  stateStore: OAuthStateStore,
): void {
  // Which connectors can be connected via OAuth (provider + client both set).
  app.get('/api/connectors/oauth-capable', async (_request, reply) => {
    const connectors = Object.keys(config.providers).filter((id) => isOAuthCapable(config, id));
    return reply.send({ connectors });
  });

  // Begin the flow: issue state, return the provider authorize URL.
  app.get(
    '/api/connectors/:id/oauth/start',
    { preHandler: requireAction('edit') },
    async (request, reply) => {
      const session = request.session as Session;
      const { id } = request.params as { id: string };
      if (!isOAuthCapable(config, id)) {
        return reply.code(400).send({ error: `connector "${id}" is not OAuth-capable` });
      }
      const state = stateStore.issue(session.tenantId, id);
      return reply.send({ authorizeUrl: buildAuthorizeUrl(config, id, state) });
    },
  );
}

/** The public OAuth callback (a top-level browser redirect, authed by state). */
export function registerOAuthCallback(
  app: FastifyInstance,
  credentials: ConnectorCredentialStore,
  config: OAuthConfig,
  stateStore: OAuthStateStore,
  fetchImpl: typeof fetch = fetch,
): void {
  app.get('/api/oauth/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };
    const base = config.redirectBase.replace(/\/$/, '');
    if (query.error || !query.code || !query.state) {
      return reply.redirect(`${base}/connectors?oauth=error`);
    }
    const claim = stateStore.take(query.state);
    if (!claim) {
      return reply.redirect(`${base}/connectors?oauth=badstate`);
    }
    try {
      const tokens = await exchangeCode(config, claim.connectorId, query.code, fetchImpl);
      const material: Record<string, string> = { accessToken: tokens.accessToken };
      if (tokens.refreshToken) material.refreshToken = tokens.refreshToken;
      if (tokens.expiresAt) material.expiresAt = tokens.expiresAt;
      // OAuth creates a named connection for the connector type (default name
      // is the type id; the user can rename it on the connections list).
      const record = await credentials.createConnection(claim.tenantId, {
        name: claim.connectorId,
        connectorId: claim.connectorId,
        material,
      });
      return reply.redirect(
        `${base}/connectors?oauth=connected&id=${encodeURIComponent(record.connectionId)}`,
      );
    } catch {
      return reply.redirect(`${base}/connectors?oauth=failed`);
    }
  });
}
