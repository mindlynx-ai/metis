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
 * "Connect your Helix account": an OIDC authorization-code flow with PKCE
 * that LINKS a cloud identity to this instance - it never replaces the
 * local sign-in. The bearer lands in the encrypted credential vault as a
 * reserved connection and is only ever read server-side (the offers call
 * stays anonymous; entitlements and gateway calls attach it from here).
 * Absent uplift config, none of these routes mount: that is the kill
 * switch, and /api/offers (registered unconditionally in server.ts) then
 * serves the static bundled manifest.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { ConnectorCredentialStore, OfferEntry, Session } from '@mindlynx/metis-ports';
import { HELIX_ACCOUNT_CONNECTOR_ID, discoverOidc } from '@mindlynx/metis-ports';
import type { CloudEntitlementsClient, OffersClient } from '@mindlynx/metis-ports';
import { requireAction } from './auth-gate.js';

/** The offline/air-gapped offers view: everything coming soon, no network.
 *  The live manifest (when reachable) always wins over this. */
export const STATIC_OFFERS: OfferEntry[] = [
  {
    id: 'cap.data',
    title: 'Big data',
    description: 'Query millions of rows and run heavy transforms in the cloud.',
    state: 'coming-soon',
    ctaUrl: 'https://helix.example/plans',
    // The palette's uplift pitch tail; mirrors the live manifest so the
    // strip reads the same offline.
    message: 'handles millions of rows.',
  },
  {
    id: 'cap.memory',
    title: 'Memory',
    description: 'Give workflows long-term recall.',
    state: 'coming-soon',
    ctaUrl: 'https://helix.example/plans',
  },
  {
    id: 'cap.agent',
    title: 'Agents',
    description: 'Delegate steps to autonomous skills.',
    state: 'coming-soon',
    ctaUrl: 'https://helix.example/plans',
  },
  {
    id: 'cap.approvals',
    title: 'Approvals',
    description: 'Human sign-off gates inside a run.',
    state: 'coming-soon',
    ctaUrl: 'https://helix.example/plans',
  },
  {
    id: 'cap.model',
    title: 'Models',
    description: 'Managed AI models with spending caps.',
    state: 'coming-soon',
    ctaUrl: 'https://helix.example/plans',
  },
];

export interface UpliftDeps {
  offers: OffersClient;
  entitlements: CloudEntitlementsClient;
  credentials: ConnectorCredentialStore;
  /**
   * The OIDC issuer base (the stub, or the real Helix identity). Every
   * endpoint is resolved from its discovery document - real Keycloak lives
   * under /realms/<realm>/protocol/openid-connect/*, so paths are never
   * assumed.
   */
  identityUrl: string;
  /** Base for this instance's own callback URL (mirrors OAuthConfig.redirectBase). */
  redirectBase: string;
  /**
   * The OIDC client this instance authenticates as. Defaults to the
   * realm-as-code client `metis-editor`; the id_token `aud` (and so the
   * verify audience) is this client. Configurable via METIS_HELIX_CLIENT_ID
   * for a realm that registers a different client id.
   */
  clientId?: string;
}

/** The realm-as-code client id (terraform/keycloak clients.tf: metis-editor). */
const DEFAULT_CLIENT_ID = 'metis-editor';

/** The configured client id, or the realm default. */
function clientIdFor(deps: UpliftDeps): string {
  return deps.clientId ?? DEFAULT_CLIENT_ID;
}

/** state -> the PKCE verifier + nonce + tenant, single-use, 10-minute TTL. */
export class ConnectStateStore {
  private readonly states = new Map<
    string,
    { tenantId: string; verifier: string; nonce: string; at: number }
  >();
  private readonly ttlMs = 10 * 60 * 1000;

  issue(tenantId: string, verifier: string, nonce: string): string {
    const state = randomBytes(24).toString('base64url');
    this.states.set(state, { tenantId, verifier, nonce, at: Date.now() });
    return state;
  }

  take(state: string): { tenantId: string; verifier: string; nonce: string } | undefined {
    const entry = this.states.get(state);
    this.states.delete(state);
    if (!entry || Date.now() - entry.at > this.ttlMs) return undefined;
    return entry;
  }
}

async function accountLink(credentials: ConnectorCredentialStore, tenantId: string) {
  const connections = await credentials.listConnections(tenantId);
  return connections.find((connection) => connection.connectorId === HELIX_ACCOUNT_CONNECTOR_ID);
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

/** Swap the code at the DISCOVERED token endpoint; undefined = failed. */
async function exchangeCode(
  deps: UpliftDeps,
  code: string,
  verifier: string,
): Promise<TokenResponse | undefined> {
  try {
    const discovery = await discoverOidc(deps.identityUrl);
    const response = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${deps.redirectBase}/api/account/callback`,
        client_id: clientIdFor(deps),
        code_verifier: verifier,
      }).toString(),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as TokenResponse;
  } catch {
    return undefined;
  }
}

// One remote JWKS per jwks_uri: jose caches the keys behind it.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, jwks);
  }
  return jwks;
}

/**
 * Verify the id_token against the discovery document: RS256 signature via
 * jwks_uri, issuer, audience (this client), and the nonce bound at
 * connect. Undefined = verification failed, store nothing. Email comes
 * from HERE - the verified claims - never from a convenience field.
 */
async function verifyIdToken(
  deps: UpliftDeps,
  idToken: string,
  nonce: string,
): Promise<{ email?: string } | undefined> {
  try {
    const discovery = await discoverOidc(deps.identityUrl);
    const { payload } = await jwtVerify(idToken, jwksFor(discovery.jwks_uri), {
      issuer: discovery.issuer,
      audience: clientIdFor(deps),
      algorithms: ['RS256'],
    });
    if (payload.nonce !== nonce) return undefined;
    return { email: typeof payload.email === 'string' ? payload.email : undefined };
  } catch {
    return undefined;
  }
}

/** The public, state-authed OIDC callback (mounted on the root app). */
export function registerAccountCallback(
  app: FastifyInstance,
  deps: UpliftDeps,
  states: ConnectStateStore,
): void {
  app.get('/api/account/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string };
    const grant = states.take(query.state ?? '');
    if (!grant || !query.code) return reply.redirect('/account?connect=badstate');

    const token = await exchangeCode(deps, query.code, grant.verifier);
    if (!token?.access_token || !token.id_token) return reply.redirect('/account?connect=failed');
    const claims = await verifyIdToken(deps, token.id_token, grant.nonce);
    if (!claims) return reply.redirect('/account?connect=failed');

    // One linked account per instance: replace, never accumulate.
    const existing = await accountLink(deps.credentials, grant.tenantId);
    if (existing) await deps.credentials.deleteConnection(grant.tenantId, existing.connectionId);
    await deps.credentials.createConnection(grant.tenantId, {
      name: claims.email ?? 'Helix account',
      connectorId: HELIX_ACCOUNT_CONNECTOR_ID,
      authScheme: 'bearer',
      material: {
        accessToken: token.access_token,
        ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
        expiresAt: String(Date.now() + (token.expires_in ?? 3600) * 1000),
      },
    });
    deps.entitlements.invalidate();
    return reply.redirect('/account?connected=1');
  });
}

/** The authed account surface (mounted inside the bearer-gated scope). */
export function registerAccountRoutes(
  authed: FastifyInstance,
  deps: UpliftDeps,
  states: ConnectStateStore,
): void {
  authed.post(
    '/api/account/connect',
    { preHandler: requireAction('admin') },
    async (request, reply) => {
      const session = request.session as Session;
      let authorizationEndpoint: string;
      try {
        authorizationEndpoint = (await discoverOidc(deps.identityUrl)).authorization_endpoint;
      } catch {
        return reply.code(502).send({ error: 'The identity provider could not be discovered.' });
      }
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const nonce = randomBytes(16).toString('base64url');
      const state = states.issue(session.tenantId, verifier, nonce);
      const authorizeUrl = `${authorizationEndpoint}?${new URLSearchParams({
        client_id: clientIdFor(deps),
        response_type: 'code',
        scope: 'openid email offline_access',
        redirect_uri: `${deps.redirectBase}/api/account/callback`,
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString()}`;
      return reply.send({ authorizeUrl });
    },
  );

  authed.get('/api/account', async (request, reply) => {
    const session = request.session as Session;
    const link = await accountLink(deps.credentials, session.tenantId);
    if (!link) return reply.send({ connected: false });
    const account = await deps.entitlements.account();
    return reply.send({ connected: true, account: { email: account?.email ?? link.name } });
  });

  authed.delete(
    '/api/account',
    { preHandler: requireAction('admin') },
    async (request, reply) => {
      const session = request.session as Session;
      const link = await accountLink(deps.credentials, session.tenantId);
      if (link) await deps.credentials.deleteConnection(session.tenantId, link.connectionId);
      deps.entitlements.invalidate();
      return reply.send({ connected: false });
    },
  );
}

