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
import type { AuditStore } from '@mindlynx/metis-data-gateway';
import { requireAction } from './auth-gate.js';

/**
 * Where a reader is sent to buy. A real published page rather than a
 * placeholder: this manifest is what a public instance serves when it has no
 * gateway, so a dead link here is a dead link on the storefront.
 */
const PLANS_URL = 'https://docs.metisflow.io/pricing/';

/**
 * One plan, deliberately. Pricing every capability separately is a decision
 * this product has not earned yet, so everything purchasable sits in the same
 * subscription and capabilities join it as they ship. Changing the price is
 * editing PRO_PRICE and the pricing page, nothing else.
 *
 * What it buys is work that runs somewhere else. Everything that runs on your
 * own machine - every node type, the sign-off gate, the audit log - is in the
 * download, and no plan is required to use any of it.
 */
export const PRO_PRICE = { amount: 900, currency: 'GBP', interval: 'month' } as const;

/**
 * The offline/air-gapped offers view. The live manifest (when a gateway is
 * reachable) always wins over this, so the two must agree on shape: a
 * capability is `available` when it can be BOUGHT, which is independent of
 * whether this instance is entitled to it. Entitlement comes from
 * /api/entitlements and nothing here can grant it.
 */
export const STATIC_OFFERS: OfferEntry[] = [
  {
    id: 'cap.data',
    title: 'Big data',
    description: 'Query millions of rows and run heavy transforms in the cloud.',
    // The one capability that genuinely cannot run on your own machine: the
    // query executes on a warehouse someone else operates. That is what makes
    // it the honest thing to charge for, and why it is the first one priced.
    state: 'available',
    ctaUrl: PLANS_URL,
    price: PRO_PRICE,
    // The palette's uplift pitch tail; mirrors the live manifest so the
    // strip reads the same offline.
    message: 'handles millions of rows.',
  },
  {
    id: 'cap.memory',
    title: 'Memory',
    description: 'Give workflows long-term recall.',
    state: 'coming-soon',
    ctaUrl: PLANS_URL,
  },
  {
    id: 'cap.agent',
    title: 'Agents',
    description: 'Delegate steps to autonomous skills.',
    state: 'coming-soon',
    ctaUrl: PLANS_URL,
  },
  {
    id: 'cap.model',
    title: 'Models',
    description: 'Managed AI models with spending caps.',
    state: 'coming-soon',
    ctaUrl: PLANS_URL,
  },
  // The enterprise axis. A download runs one tenant and the handful of users
  // its environment seeds, which is the right shape for the people who run it
  // themselves; an organisation that needs many of both is buying something
  // this build does not pretend to be.
  {
    id: 'cap.tenancy',
    title: 'Multi-tenancy',
    description: 'One instance serving many separate organisations, each sealed off.',
    state: 'coming-soon',
    ctaUrl: PLANS_URL,
    scope: 'plan',
  },
  {
    id: 'cap.identity',
    title: 'Teams and sign-on',
    description: 'A real user directory, invites and single sign-on.',
    state: 'coming-soon',
    ctaUrl: PLANS_URL,
    scope: 'plan',
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

/**
 * Ceiling on the code exchange. Somebody is sitting on a redirect back from the
 * identity server waiting for this, so a long wait is no better to them than a
 * clean failure they can retry; and this runs inside an inbound request, which
 * had nothing bounding it at all.
 */
const EXCHANGE_TIMEOUT_MS = 10_000;

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
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
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
  audit?: AuditStore,
): void {
  const trail = (session: Session, action: string, entityType: string, entityId: string) =>
    audit?.record({
      tenantId: session.tenantId,
      actor: session.userId,
      action,
      entityType,
      entityId,
      outcome: 'ok',
    });

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
      if (link) {
        await deps.credentials.deleteConnection(session.tenantId, link.connectionId);
        // Two entries, because two things went and each answers a question
        // keyed on a different entity. The account line is the instance-level
        // fact - this box is no longer linked to a Helix account - and no
        // connection id identifies that; there is one link per instance, so the
        // reserved connector id IS its id. The connection line is there because
        // this route deletes the vault row itself instead of going through
        // /api/connections: without it, "what became of connection X" ends
        // mid-sentence for the one credential that reaches a paid service.
        await trail(session, 'account.disconnected', 'account', HELIX_ACCOUNT_CONNECTOR_ID);
        await trail(session, 'connection.deleted', 'connection', String(link.connectionId));
      }
      deps.entitlements.invalidate();
      return reply.send({ connected: false });
    },
  );
}

