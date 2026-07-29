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
 * actually works. It returns a verdict only, never the material, and separates
 * auth failure (bad key/password) from unreachable (DNS/refused/timeout) so the
 * connections list can say what is wrong.
 *
 * A connection whose connector names a registered data engine is probed
 * THROUGH THAT ENGINE'S OWN ADAPTER with a `SELECT 1`. That matters more than
 * it sounds: dispatching on the auth scheme alone sent every `database`
 * connection to a Postgres client, so a working MySQL read red, and sent
 * Snowflake down the http path where a bare GET of its console URL answered
 * 200 and read green no matter what the credentials were. A test that cannot
 * fail is worse than no test.
 *
 * A `database` connector with no adapter splits two ways. Postgres (by name, or
 * by a bare connectionString with nothing else to go on) still goes to the
 * Postgres client: that is the right client, and it is the path a tester built
 * without a registry takes. Any OTHER engine gets a plain "connect-only"
 * verdict instead. It used to get the Postgres client too, which answered about
 * a protocol the server does not speak: a connection pointed at its own engine
 * read red, and one pointed at a Postgres box read green. Both verdicts were
 * noise an operator could act on. Every engine in the open catalogue now has an
 * adapter, so that branch guards the NEXT engine catalogued before its adapter,
 * rather than any engine shipping today.
 *
 * The http schemes do an SSRF-guarded probe of the connector's baseUrl (or its
 * declared healthCheck) carrying the auth headers.
 *
 * An object store (`sigv4`) is probed with a SIGNED list of one key. It cannot
 * go down the http path: S3 answers 403 to an unsigned request whether the
 * credentials are good, bad or absent, so a working connection would read red
 * and no verdict would mean anything.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { authHeadersFromMaterial } from './auth-headers.js';
import { checkUrlForSsrf } from './http-node.js';
import { checkEndpoint, resolveTarget, s3Error, s3Request } from './s3-client.js';
import type {
  ConnectionHealth,
  ConnectionStatus,
  ConnectionTester,
  ConnectionTestInput,
  DataSource,
  DataSourceRegistry,
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
  // MySQL names its refusals, and an HTTP engine (Snowflake) reports them in
  // the message; both mean "reached it, credentials rejected". SQL Server folds
  // every login-phase refusal into ELOGIN, which covers a bad password and a
  // database the login cannot open alike.
  if (code.startsWith('ER_ACCESS_DENIED') || code === 'ER_DBACCESS_DENIED_ERROR' || code === 'ELOGIN') {
    return verdict('auth_failed', message);
  }
  // Snowflake says "JWT token is invalid"; other services put it the other way
  // round, or answer with a bare status. Catch the shapes, not one wording.
  const refused =
    /\b(401|403)\b/.test(message) ||
    /unauthorized|authentication failed|invalid credentials/i.test(message) ||
    (/\b(jwt|token)\b/i.test(message) && /invalid|expired|malformed/i.test(message));
  if (refused) return verdict('auth_failed', message);
  // SQL Server has its own spellings for never getting there: ESOCKET wraps the
  // refused or reset socket, and its timeout is ETIMEOUT, one letter off the
  // one every other client uses.
  if (['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ESOCKET', 'ETIMEOUT'].includes(code)) {
    return verdict('unreachable', message);
  }
  return verdict('error', message);
}

async function testPostgres(material: Record<string, string>): Promise<ConnectionHealth> {
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

/**
 * The pool key a probe opens under: the engine plus a fingerprint of the WHOLE
 * of the material. It used to name the visible fields (host, database, user)
 * and leave the password out, which meant two connections differing only in
 * their password shared a pool: the second probe was answered by the first
 * one's connection and a wrong password read green. That is the one verdict a
 * tester must never give. The material is hashed rather than spelt out, because
 * a pool key is a thing that gets compared and logged and a secret is not.
 */
export function probeKey(engine: string, material: Record<string, string>): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(Object.entries(material).sort()))
    .digest('hex')
    .slice(0, 16);
  return `probe:${engine}:${fingerprint}`;
}

/** Probe an engine through its own adapter, with a SELECT 1. */
async function testDataSource(
  source: DataSource,
  input: ConnectionTestInput,
): Promise<ConnectionHealth> {
  const m = input.material;
  const key = probeKey(source.engine, m);
  try {
    await source.runQuery({ key, material: m }, 'SELECT 1', { maxRows: 1 });
    return verdict('ok', 'SELECT 1 succeeded');
  } catch (error) {
    return classifyDbError(error);
  }
}

/**
 * Probe an object store by listing one key. A signed request is the only thing
 * that proves an S3 connection: the endpoint answers 403 to an unsigned GET
 * whether the credentials are right, wrong or absent, so the http probe would
 * read red on a perfectly good connection.
 */
async function testS3(input: ConnectionTestInput): Promise<ConnectionHealth> {
  const target = resolveTarget(input.material);
  if ('error' in target) return verdict('error', target.error);
  const blocked = await checkEndpoint(target, input.material);
  if (blocked) return verdict('error', blocked);
  try {
    const response = await s3Request(target, { method: 'GET', query: { 'list-type': '2', 'max-keys': '1' } });
    if (response.status === 401 || response.status === 403) {
      return verdict('auth_failed', await s3Error(response, 'list'));
    }
    if (!response.ok) return verdict('error', await s3Error(response, 'list'));
    await response.text();
    return verdict('ok', `listed ${target.bucket}`);
  } catch (error) {
    return verdict('unreachable', error instanceof Error ? error.message : String(error));
  }
}

export class DefaultConnectionTester implements ConnectionTester {
  constructor(private readonly dataSources?: DataSourceRegistry) {}

  async testConnection(input: ConnectionTestInput): Promise<ConnectionHealth> {
    try {
      if (input.authScheme === 'none') return verdict('ok', 'no credentials needed');
      if (input.authScheme === 'sigv4') return await testS3(input);
      // A data engine is proven by querying it, whatever auth scheme its
      // catalogue record happens to declare.
      const source = this.dataSources?.get(input.connectorId);
      if (source) return await testDataSource(source, input);
      if (input.authScheme === 'database') {
        // No adapter was registered for this engine. Postgres is still safe to
        // probe directly (right client, and the path a registry-less tester
        // takes); a bare connectionString with no engine named is treated the
        // same way, which is what it has always meant here.
        if (input.connectorId === 'postgres' || (!input.connectorId && input.material.connectionString)) {
          return await testPostgres(input.material);
        }
        // Anything else has no client that speaks its wire protocol, so a probe
        // would be guessing. Refuse to guess.
        return verdict(
          'error',
          `${input.connectorId} is connect-only for now: its credentials can be stored, but there is no adapter to test or query it with yet.`,
        );
      }
      if (input.authScheme === 'client_credentials') {
        return await testClientCredentials(input.material);
      }
      return await testHttp(input);
    } catch (error) {
      return verdict('error', error instanceof Error ? error.message : String(error));
    }
  }
}
