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
 * The default connection tester (observability): proves a stored connection
 * actually works. `database` runs a short-lived `SELECT 1`; the http schemes
 * do an SSRF-guarded GET of the connector's baseUrl carrying the connection's
 * auth headers. It returns a verdict only, never the material, and separates
 * auth failure (bad key/password) from unreachable (DNS/refused/timeout) so the
 * connections list can say what is wrong.
 */
import pg from 'pg';
import { authHeadersFromMaterial } from './auth-headers.js';
import { checkUrlForSsrf } from './http-node.js';
import type {
  ConnectionHealth,
  ConnectionStatus,
  ConnectionTester,
  ConnectionTestInput,
} from '@mindlynx/metis-ports';

const PROBE_TIMEOUT_MS = 8000;

function verdict(status: ConnectionStatus, message?: string): ConnectionHealth {
  return { status, ok: status === 'ok', message, checkedAt: new Date().toISOString() };
}

/** Postgres SQLSTATE codes that mean "reached the server, credentials/db rejected". */
const PG_AUTH_CODES = new Set(['28P01', '28000', '3D000']); // bad password, invalid auth, unknown db

export function classifyDbError(error: unknown): ConnectionHealth {
  const code = (error as { code?: string }).code ?? '';
  const message = error instanceof Error ? error.message : String(error);
  if (PG_AUTH_CODES.has(code)) return verdict('auth_failed', message);
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
    return verdict('unreachable', message);
  }
  return verdict('error', message);
}

async function testDatabase(material: Record<string, string>): Promise<ConnectionHealth> {
  const client = new pg.Client(
    material.connectionString
      ? { connectionString: material.connectionString, connectionTimeoutMillis: PROBE_TIMEOUT_MS }
      : {
          host: material.host,
          port: material.port ? Number(material.port) : undefined,
          database: material.database,
          user: material.user,
          password: material.password,
          connectionTimeoutMillis: PROBE_TIMEOUT_MS,
        },
  );
  try {
    await client.connect();
    await client.query('SELECT 1');
    return verdict('ok', 'SELECT 1 succeeded');
  } catch (error) {
    return classifyDbError(error);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function httpAuthHeaders(input: ConnectionTestInput): Record<string, string> {
  return authHeadersFromMaterial(input.authScheme, input.material, input.authHeaderName);
}

/**
 * Machine-to-machine (OAuth2 client-credentials): exchange the client id/secret
 * at the token URL and check a token comes back. Proves the credentials work
 * without any user interaction.
 */
async function testClientCredentials(material: Record<string, string>): Promise<ConnectionHealth> {
  const tokenUrl = material.tokenUrl;
  if (!tokenUrl) return verdict('error', 'no token URL');
  const ssrf = await checkUrlForSsrf(tokenUrl);
  if (!ssrf.allowed) return verdict('error', ssrf.reason);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: material.clientId ?? '',
    client_secret: material.clientSecret ?? '',
  });
  if (material.scopes) body.set('scope', material.scopes);
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return verdict('auth_failed', `token endpoint returned ${response.status}`);
    }
    if (!response.ok) return verdict('error', `token endpoint returned ${response.status}`);
    const json = (await response.json().catch(() => ({}))) as { access_token?: string };
    return json.access_token
      ? verdict('ok', 'obtained an access token')
      : verdict('error', 'no access_token in the response');
  } catch (error) {
    return verdict('unreachable', error instanceof Error ? error.message : String(error));
  }
}

/**
 * The request the http probe sends: a bare GET of the base URL by default, or
 * the connector's custom healthCheck (method + path relative to baseUrl +
 * optional JSON body) when the root URL cannot validate the key. Returns a
 * string when there is nothing to probe. Pure, so it is unit-tested directly.
 */
export function resolveHttpProbe(
  input: ConnectionTestInput,
): { url: string; method: string; body?: string } | string {
  if (!input.baseUrl) return 'connector has no base URL to probe';
  const hc = input.healthCheck;
  if (!hc) return { url: input.baseUrl, method: 'GET' };
  const url = new URL(hc.path, input.baseUrl).toString();
  return { url, method: hc.method, body: hc.body === undefined ? undefined : JSON.stringify(hc.body) };
}

async function testHttp(input: ConnectionTestInput): Promise<ConnectionHealth> {
  const probe = resolveHttpProbe(input);
  if (typeof probe === 'string') return verdict('error', probe);
  const ssrf = await checkUrlForSsrf(probe.url);
  if (!ssrf.allowed) return verdict('error', ssrf.reason);
  const headers = httpAuthHeaders(input);
  if (probe.body !== undefined) headers['content-type'] = 'application/json';
  try {
    const response = await fetch(probe.url, {
      method: probe.method,
      headers,
      body: probe.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return verdict('auth_failed', `service returned ${response.status}`);
    }
    // Any other response means the service is reachable and the key was accepted
    // (a required-field 4xx from the health probe still proves auth); the root
    // path may not be a real endpoint, so a 404 still proves reachability.
    return verdict('ok', `reachable (HTTP ${response.status})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return verdict('unreachable', message);
  }
}

export class DefaultConnectionTester implements ConnectionTester {
  async testConnection(input: ConnectionTestInput): Promise<ConnectionHealth> {
    try {
      if (input.authScheme === 'none') return verdict('ok', 'no credentials needed');
      if (input.authScheme === 'database') return await testDatabase(input.material);
      if (input.authScheme === 'client_credentials') {
        return await testClientCredentials(input.material);
      }
      return await testHttp(input);
    } catch (error) {
      return verdict('error', error instanceof Error ? error.message : String(error));
    }
  }
}
