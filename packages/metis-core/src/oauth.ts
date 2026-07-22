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
 * OAuth2 authorization-code support for connectors. The operator registers
 * their own OAuth app per connector and supplies the client id/secret via env
 * (METIS_OAUTH_<CONNECTOR>_CLIENT_ID / _SECRET); the endpoints for well-known
 * providers are here. A connector is OAuth-capable only when both a provider
 * entry and client config exist. No secret is ever returned to the browser;
 * only the resulting tokens are stored as a connection.
 */
import { randomBytes } from 'node:crypto';

export interface OAuthProvider {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Well-known provider endpoints. Client credentials come from env. */
export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:user'],
  },
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  },
  slack: {
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: ['channels:read', 'chat:write'],
  },
};

const envKey = (connectorId: string): string => connectorId.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/** The operator's OAuth client for a connector, from env (undefined if unset). */
export function oauthClientFromEnv(
  connectorId: string,
  env: NodeJS.ProcessEnv = process.env,
): OAuthClient | undefined {
  const key = envKey(connectorId);
  const clientId = env[`METIS_OAUTH_${key}_CLIENT_ID`];
  const clientSecret = env[`METIS_OAUTH_${key}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

export const oauthRedirectBase = (env: NodeJS.ProcessEnv = process.env): string =>
  env.METIS_OAUTH_REDIRECT_BASE ?? `http://localhost:${env.METIS_EDITOR_PORT ?? 3000}`;

/** The config an OAuth service needs; injectable so tests use a mock provider. */
export interface OAuthConfig {
  providers: Record<string, OAuthProvider>;
  clientFor(connectorId: string): OAuthClient | undefined;
  redirectBase: string;
}

export function defaultOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  return {
    providers: OAUTH_PROVIDERS,
    clientFor: (id) => oauthClientFromEnv(id, env),
    redirectBase: oauthRedirectBase(env),
  };
}

/** Is this connector OAuth-capable (provider entry + client config both present)? */
export function isOAuthCapable(config: OAuthConfig, connectorId: string): boolean {
  return Boolean(config.providers[connectorId] && config.clientFor(connectorId));
}

const redirectUri = (config: OAuthConfig): string =>
  `${config.redirectBase.replace(/\/$/, '')}/api/oauth/callback`;

/** Build the provider authorize URL for a connector + opaque state. */
export function buildAuthorizeUrl(config: OAuthConfig, connectorId: string, state: string): string {
  const provider = config.providers[connectorId];
  const client = config.clientFor(connectorId);
  if (!provider || !client) throw new Error(`connector "${connectorId}" is not OAuth-capable`);
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', redirectUri(config));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', provider.scopes.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

/** Exchange an authorization code for tokens at the provider token endpoint. */
export async function exchangeCode(
  config: OAuthConfig,
  connectorId: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const provider = config.providers[connectorId];
  const client = config.clientFor(connectorId);
  if (!provider || !client) throw new Error(`connector "${connectorId}" is not OAuth-capable`);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri(config),
  });
  const response = await fetchImpl(provider.tokenUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`token exchange failed (${response.status})`);
  }
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) throw new Error('token exchange returned no access_token');
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000).toISOString()
      : undefined,
  };
}

/** Short-lived CSRF state store: state -> {tenantId, connectorId}, 10-minute TTL. */
export class OAuthStateStore {
  private readonly states = new Map<string, { tenantId: string; connectorId: string; at: number }>();
  private readonly ttlMs = 10 * 60 * 1000;

  constructor(private readonly now: () => number = () => Date.now()) {}

  issue(tenantId: string, connectorId: string): string {
    const state = randomBytes(24).toString('base64url');
    this.states.set(state, { tenantId, connectorId, at: this.now() });
    return state;
  }

  take(state: string): { tenantId: string; connectorId: string } | undefined {
    const entry = this.states.get(state);
    this.states.delete(state);
    if (!entry || this.now() - entry.at > this.ttlMs) return undefined;
    return { tenantId: entry.tenantId, connectorId: entry.connectorId };
  }
}
