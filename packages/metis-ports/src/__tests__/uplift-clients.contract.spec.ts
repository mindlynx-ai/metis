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
 * Contract tests: the three uplift clients against the Helix stub. The
 * stub IS the contract the real estate must satisfy, so these lock the
 * accepted / done / failed / unentitled / version-mismatch / unreachable
 * behaviours plus the OIDC-shaped connect round-trip.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import {
  CapabilityGatewayClient,
  CloudEntitlementsClient,
  ContractMismatchError,
  GatewayUnreachableError,
  OffersClient,
  UnentitledError,
  discoverOidc,
} from '../uplift.js';
import { startHelixStub, STUB_OFFERS, type HelixStub } from '../adapters/helix-stub.js';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  id_token?: string;
  email?: string;
}

/** Full code-grant dance against the stub, as the connect flow would run it. */
async function codeGrant(stubUrl: string, nonce?: string): Promise<TokenResponse> {
  const query = new URLSearchParams({
    client_id: 'metis',
    redirect_uri: 'http://127.0.0.1:9/api/account/callback',
    state: 'st-1',
    ...(nonce ? { nonce } : {}),
    code_challenge: 'abc',
    code_challenge_method: 'S256',
  });
  const authorize = await fetch(`${stubUrl}/oidc/authorize?${query.toString()}`, {
    redirect: 'manual',
  });
  const location = new URL(authorize.headers.get('location') ?? '');
  const code = location.searchParams.get('code') ?? '';
  const token = await fetch(`${stubUrl}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: 'v' }).toString(),
  });
  return (await token.json()) as TokenResponse;
}

async function refreshGrant(stubUrl: string, refreshToken: string): Promise<Response> {
  return fetch(`${stubUrl}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'metis',
    }).toString(),
  });
}

let stub: HelixStub | undefined;

afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

function gateway(stubUrl: string, bearer?: string): CapabilityGatewayClient {
  return new CapabilityGatewayClient({
    baseUrl: stubUrl,
    getBearer: async () => bearer,
    timeoutMs: 2_000,
  });
}

describe('capability gateway client', () => {
  it('invokes an entitled capability and polls the job to done', async () => {
    stub = await startHelixStub();
    const client = gateway(stub.url, stub.issueToken());
    const accepted = await client.invoke('data', { config: { sql: 'select 1' } });
    expect(accepted.status).toBe('accepted');
    expect(accepted.jobId).toMatch(/^job_/);
    const job = await client.job(accepted.jobId);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ cloud: true, capability: 'data' });
  });

  it('surfaces a failed job with its error', async () => {
    stub = await startHelixStub({ failJobs: true });
    const client = gateway(stub.url, stub.issueToken());
    const accepted = await client.invoke('data', {});
    const job = await client.job(accepted.jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toBeTruthy();
  });

  it('maps unentitled to UnentitledError carrying the upgrade offer', async () => {
    stub = await startHelixStub({ entitled: [] });
    const client = gateway(stub.url, stub.issueToken());
    const error = await client.invoke('data', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnentitledError);
    expect((error as UnentitledError).offer?.id).toBe('cap.data');
  });

  it('treats a missing bearer as unentitled, never as entitled', async () => {
    stub = await startHelixStub();
    const client = gateway(stub.url, undefined);
    await expect(client.invoke('data', {})).rejects.toBeInstanceOf(UnentitledError);
  });

  it('fails closed on a contract version mismatch', async () => {
    stub = await startHelixStub({ contractVersion: '2' });
    const client = gateway(stub.url, stub.issueToken());
    const error = await client.invoke('data', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContractMismatchError);
    expect((error as Error).message).toContain('Update Metis');
  });

  it('raises GatewayUnreachableError when nothing is listening', async () => {
    const client = gateway('http://127.0.0.1:1', 'any');
    await expect(client.invoke('data', {})).rejects.toBeInstanceOf(GatewayUnreachableError);
  });

  it('propagates cancel to the job', async () => {
    stub = await startHelixStub({ jobDelayMs: 60_000 });
    const client = gateway(stub.url, stub.issueToken());
    const accepted = await client.invoke('data', {});
    await client.cancel(accepted.jobId);
    expect(stub.cancelled).toContain(accepted.jobId);
    const job = await client.job(accepted.jobId);
    expect(job.status).toBe('cancelled');
  });
});

describe('offers client', () => {
  it('returns the manifest anonymously and caches it', async () => {
    stub = await startHelixStub();
    const client = new OffersClient({ baseUrl: stub.url });
    const offers = await client.offers();
    expect(offers).toEqual(STUB_OFFERS);
    await client.offers();
    expect(stub.requests['/v1/offers']).toBe(1);
  });

  it('throws GatewayUnreachableError offline so callers fall back to static', async () => {
    const client = new OffersClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
    await expect(client.offers()).rejects.toBeInstanceOf(GatewayUnreachableError);
  });
});

describe('entitlements client (fail closed)', () => {
  it('returns the capability set and account for a valid bearer', async () => {
    stub = await startHelixStub({ entitled: ['cap.data', 'cap.memory'] });
    const client = new CloudEntitlementsClient({
      baseUrl: stub.url,
      getBearer: async () => stub?.issueToken('a@helix.example'),
    });
    expect(await client.capabilities()).toEqual(new Set(['cap.data', 'cap.memory']));
    expect((await client.account())?.email).toBe('a@helix.example');
  });

  it.each([
    ['no bearer', async () => undefined],
    ['unknown bearer', async () => 'stub_forged'],
  ])('reads as EMPTY with %s', async (_name, getBearer) => {
    stub = await startHelixStub({ entitled: ['cap.data'] });
    const client = new CloudEntitlementsClient({ baseUrl: stub.url, getBearer });
    expect((await client.capabilities()).size).toBe(0);
  });

  it('reads as EMPTY when the gateway is unreachable', async () => {
    const client = new CloudEntitlementsClient({
      baseUrl: 'http://127.0.0.1:1',
      getBearer: async () => 'any',
      timeoutMs: 500,
    });
    expect((await client.capabilities()).size).toBe(0);
  });

  it('invalidate() drops the cache so a disconnect is immediate', async () => {
    stub = await startHelixStub({ entitled: ['cap.data'] });
    let bearer: string | undefined = stub.issueToken();
    const client = new CloudEntitlementsClient({ baseUrl: stub.url, getBearer: async () => bearer });
    expect((await client.capabilities()).size).toBe(1);
    bearer = undefined;
    expect((await client.capabilities()).size).toBe(1); // still cached
    client.invalidate();
    expect((await client.capabilities()).size).toBe(0);
  });
});

describe('OIDC connect round-trip', () => {
  it('authorize redirects with a code; token swaps it for a working bearer and a verifiable id_token', async () => {
    stub = await startHelixStub({ email: 'jeremy@helix.example' });
    const authorize = await fetch(
      `${stub.url}/oidc/authorize?client_id=metis&redirect_uri=${encodeURIComponent(
        'http://127.0.0.1:9/api/account/callback',
      )}&state=st-1&nonce=n-1&code_challenge=abc&code_challenge_method=S256`,
      { redirect: 'manual' },
    );
    expect(authorize.status).toBe(302);
    const location = new URL(authorize.headers.get('location') ?? '');
    expect(location.pathname).toBe('/api/account/callback');
    expect(location.searchParams.get('state')).toBe('st-1');
    const code = location.searchParams.get('code') ?? '';
    expect(code).toMatch(/^code_/);

    const token = await fetch(`${stub.url}/oidc/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: 'v' }).toString(),
    });
    const body = (await token.json()) as TokenResponse;
    // No convenience email field: identity travels ONLY in the verified id_token.
    expect(body.email).toBeUndefined();
    expect(body.refresh_token).toMatch(/^refresh_/);
    expect(body.expires_in).toBe(3600);

    // Verify the id_token by hand against the served JWKS: RS256, correct
    // issuer/audience, the nonce echoed, email inside the claims.
    const [header, payload, signature] = (body.id_token ?? '').split('.');
    const jwks = (await (await fetch(`${stub.url}/oidc/jwks`)).json()) as { keys: Record<string, unknown>[] };
    const key = createPublicKey({ key: jwks.keys[0], format: 'jwk' });
    expect(
      cryptoVerify('sha256', Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, 'base64url')),
    ).toBe(true);
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
    expect(claims.iss).toBe(stub.url);
    expect(claims.aud).toBe('metis');
    expect(claims.nonce).toBe('n-1');
    expect(claims.email).toBe('jeremy@helix.example');

    const entitlements = new CloudEntitlementsClient({
      baseUrl: stub.url,
      getBearer: async () => body.access_token,
    });
    expect(await entitlements.capabilities()).toEqual(new Set(['cap.data']));
  });

  it('rejects a reused or unknown code', async () => {
    stub = await startHelixStub();
    const response = await fetch(`${stub.url}/oidc/token`, {
      method: 'POST',
      body: new URLSearchParams({ code: 'code_unknown' }).toString(),
    });
    expect(response.status).toBe(400);
  });
});

describe('OIDC discovery', () => {
  it('serves the discovery document with real endpoints', async () => {
    stub = await startHelixStub();
    const doc = await discoverOidc(stub.url);
    expect(doc).toEqual({
      issuer: stub.url,
      authorization_endpoint: `${stub.url}/oidc/authorize`,
      token_endpoint: `${stub.url}/oidc/token`,
      jwks_uri: `${stub.url}/oidc/jwks`,
    });
  });

  it('discoverOidc caches per issuer url', async () => {
    stub = await startHelixStub();
    await discoverOidc(stub.url);
    await discoverOidc(stub.url);
    expect(stub.requests['/.well-known/openid-configuration']).toBe(1);
  });
});

describe('refresh rotation at the stub', () => {
  it('rotates the pair; a replayed refresh token revokes the whole family', async () => {
    stub = await startHelixStub();
    const first = await codeGrant(stub.url);

    // Happy rotation: new access + refresh, both live.
    const rotated = (await (await refreshGrant(stub.url, first.refresh_token)).json()) as TokenResponse;
    expect(rotated.access_token).not.toBe(first.access_token);
    expect(rotated.refresh_token).not.toBe(first.refresh_token);
    const entitlements = new CloudEntitlementsClient({
      baseUrl: stub.url,
      getBearer: async () => rotated.access_token,
    });
    expect((await entitlements.capabilities()).size).toBe(1);

    // Reuse detection: replaying the rotated token is invalid_grant AND
    // kills the family - the rotated access token dies with it.
    const replay = await refreshGrant(stub.url, first.refresh_token);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
    entitlements.invalidate();
    expect((await entitlements.capabilities()).size).toBe(0);

    // The whole family is dead: the rotated refresh token no longer works.
    expect((await refreshGrant(stub.url, rotated.refresh_token)).status).toBe(400);
  });

  it('rejects an unknown refresh token without touching anything', async () => {
    stub = await startHelixStub();
    expect((await refreshGrant(stub.url, 'refresh_forged')).status).toBe(400);
  });
});
