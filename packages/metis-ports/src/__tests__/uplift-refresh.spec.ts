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
 * Rotation-safe refresh (the R3 gap): the vault-backed bearer getter
 * transparently rotates an expiring access token via the discovered token
 * endpoint, single-flights concurrent refreshes, fails closed to a clean
 * disconnected state on reuse detection, and survives transient outages.
 * Plus the 401-retry-once behaviour on both bearer-authed clients.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CapabilityGatewayClient,
  CloudEntitlementsClient,
  HELIX_ACCOUNT_CONNECTOR_ID,
  UnentitledError,
  helixAccountBearer,
} from '../uplift.js';
import { FakeCredentialPort } from '../fakes.js';
import { startHelixStub, type HelixStub } from '../adapters/helix-stub.js';

const TENANT = 't1';

let stub: HelixStub | undefined;

afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

/** Link an account the way the connect callback does: real stub tokens in the vault. */
async function connectAccount(
  liveStub: HelixStub,
  credentials: FakeCredentialPort,
  expiresInMs: number,
): Promise<string> {
  const authorize = await fetch(
    `${liveStub.url}/oidc/authorize?client_id=metis&redirect_uri=${encodeURIComponent(
      'http://127.0.0.1:9/cb',
    )}&state=s&nonce=n`,
    { redirect: 'manual' },
  );
  const code = new URL(authorize.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const token = (await (
    await fetch(`${liveStub.url}/oidc/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: 'metis' }).toString(),
    })
  ).json()) as { access_token: string; refresh_token: string };
  const record = await credentials.createConnection(TENANT, {
    name: 'user@helix.example',
    connectorId: HELIX_ACCOUNT_CONNECTOR_ID,
    authScheme: 'bearer',
    material: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: String(Date.now() + expiresInMs),
    },
  });
  return record.connectionId;
}

function tokenCalls(liveStub: HelixStub): number {
  return liveStub.requests['/oidc/token'] ?? 0;
}

describe('helixAccountBearer refresh', () => {
  it('rotates transparently when the access token nears expiry and updates the vault', async () => {
    stub = await startHelixStub();
    const credentials = new FakeCredentialPort();
    const connectionId = await connectAccount(stub, credentials, 1_000); // inside the 60s skew
    const before = await credentials.resolveConnectorCredentials(TENANT, connectionId);

    const getBearer = helixAccountBearer(credentials, TENANT, { identityUrl: stub.url });
    const bearer = await getBearer();

    expect(bearer).toBeTruthy();
    expect(bearer).not.toBe(before.accessToken);
    const after = await credentials.resolveConnectorCredentials(TENANT, connectionId);
    expect(after.accessToken).toBe(bearer);
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(Number(after.expiresAt)).toBeGreaterThan(Date.now() + 60_000);

    // The rotated bearer really works; the old refresh token is dead.
    const entitlements = new CloudEntitlementsClient({ baseUrl: stub.url, getBearer });
    expect((await entitlements.capabilities()).size).toBe(1);
    const replay = await fetch(`${stub.url}/oidc/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: before.refreshToken,
        client_id: 'metis',
      }).toString(),
    });
    expect(replay.status).toBe(400);
  });

  it('does not refresh a fresh token', async () => {
    stub = await startHelixStub();
    const credentials = new FakeCredentialPort();
    const connectionId = await connectAccount(stub, credentials, 3_600_000);
    const before = await credentials.resolveConnectorCredentials(TENANT, connectionId);
    const calls = tokenCalls(stub);

    const getBearer = helixAccountBearer(credentials, TENANT, { identityUrl: stub.url });
    expect(await getBearer()).toBe(before.accessToken);
    expect(tokenCalls(stub)).toBe(calls);
  });

  it('single-flights concurrent refreshes: N callers, ONE token-endpoint call', async () => {
    stub = await startHelixStub();
    const credentials = new FakeCredentialPort();
    await connectAccount(stub, credentials, 0);
    const calls = tokenCalls(stub);

    const getBearer = helixAccountBearer(credentials, TENANT, { identityUrl: stub.url });
    const bearers = await Promise.all([getBearer(), getBearer(), getBearer(), getBearer(), getBearer()]);

    expect(new Set(bearers).size).toBe(1);
    expect(bearers[0]).toBeTruthy();
    expect(tokenCalls(stub)).toBe(calls + 1);
  });

  it('two getter closures for the same tenant share one refresh (no self-inflicted reuse)', async () => {
    // The runtime builds TWO getBearer closures for the same account: one in
    // control-server (entitlements/account) and one in runtime (the cloud
    // gateway). Per-closure single-flight does not collapse ACROSS closures,
    // so both rotating at once would present the same refresh token twice ->
    // KC/stub reuse detection revokes the family -> a hard, wrong disconnect.
    stub = await startHelixStub();
    const credentials = new FakeCredentialPort();
    await connectAccount(stub, credentials, 0); // expired -> both refresh
    const calls = tokenCalls(stub);

    const getBearerA = helixAccountBearer(credentials, TENANT, { identityUrl: stub.url });
    const getBearerB = helixAccountBearer(credentials, TENANT, { identityUrl: stub.url });
    const [a, b] = await Promise.all([getBearerA(), getBearerB()]);

    // Exactly ONE rotation, both closures get a working bearer, link intact.
    expect(tokenCalls(stub)).toBe(calls + 1);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    const link = (await credentials.listConnections(TENANT)).find(
      (connection) => connection.connectorId === HELIX_ACCOUNT_CONNECTOR_ID,
    );
    expect(link).toBeTruthy();
  });

  it('reuse detection fails closed: connection cleared, bearer undefined, entitlements empty', async () => {
    stub = await startHelixStub();
    const credentials = new FakeCredentialPort();
    const connectionId = await connectAccount(stub, credentials, 0);
    const material = await credentials.resolveConnectorCredentials(TENANT, connectionId);

    // An attacker rotates with our stolen refresh token first.
    await fetch(`${stub.url}/oidc/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: material.refreshToken,
        client_id: 'metis',
      }).toString(),
    });

    // Our refresh replays a rotated token -> invalid_grant -> disconnected.
    const getBearer = helixAccountBearer(credentials, TENANT, { identityUrl: stub.url });
    expect(await getBearer()).toBeUndefined();
    const links = await credentials.listConnections(TENANT);
    expect(links.find((link) => link.connectorId === HELIX_ACCOUNT_CONNECTOR_ID)).toBeUndefined();
    expect(await getBearer()).toBeUndefined();

    // The resolver's degraded path: entitlements read as the empty set, no crash.
    const entitlements = new CloudEntitlementsClient({ baseUrl: stub.url, getBearer });
    expect((await entitlements.capabilities()).size).toBe(0);
  });

  it('keeps the connection on a transient token-endpoint failure', async () => {
    stub = await startHelixStub();
    const credentials = new FakeCredentialPort();
    await connectAccount(stub, credentials, 0);
    const identityUrl = stub.url;
    const getBearer = helixAccountBearer(credentials, TENANT, { identityUrl });
    await stub.close();
    stub = undefined;

    expect(await getBearer()).toBeUndefined();
    const links = await credentials.listConnections(TENANT);
    expect(links.find((link) => link.connectorId === HELIX_ACCOUNT_CONNECTOR_ID)).toBeTruthy();
  });
});

describe('401-retry-once on the bearer-authed clients', () => {
  it('gateway invoke refreshes exactly once after a revoked access token', async () => {
    stub = await startHelixStub();
    const credentials = new FakeCredentialPort();
    await connectAccount(stub, credentials, 3_600_000);
    const getBearer = helixAccountBearer(credentials, TENANT, { identityUrl: stub.url });
    const client = new CapabilityGatewayClient({ baseUrl: stub.url, getBearer, timeoutMs: 2_000 });

    stub.revokeAccessTokens();
    const calls = tokenCalls(stub);
    const accepted = await client.invoke('data', { config: {} });

    expect(accepted.status).toBe('accepted');
    expect(tokenCalls(stub)).toBe(calls + 1);
    expect(stub.requests['/v1/capabilities/data/invoke']).toBe(2);
  });

  it('entitlements refresh exactly once after a revoked access token', async () => {
    stub = await startHelixStub();
    const credentials = new FakeCredentialPort();
    await connectAccount(stub, credentials, 3_600_000);
    const getBearer = helixAccountBearer(credentials, TENANT, { identityUrl: stub.url });
    const client = new CloudEntitlementsClient({ baseUrl: stub.url, getBearer });

    stub.revokeAccessTokens();
    const calls = tokenCalls(stub);
    expect(await client.capabilities()).toEqual(new Set(['cap.data']));
    expect(tokenCalls(stub)).toBe(calls + 1);
  });

  it('a genuine 403 (unentitled) never triggers a refresh', async () => {
    stub = await startHelixStub({ entitled: [] });
    const credentials = new FakeCredentialPort();
    await connectAccount(stub, credentials, 3_600_000);
    const getBearer = helixAccountBearer(credentials, TENANT, { identityUrl: stub.url });
    const client = new CapabilityGatewayClient({ baseUrl: stub.url, getBearer, timeoutMs: 2_000 });

    const calls = tokenCalls(stub);
    await expect(client.invoke('data', {})).rejects.toBeInstanceOf(UnentitledError);
    expect(tokenCalls(stub)).toBe(calls);
  });

  it('fails closed as today when the refresh cannot produce a bearer', async () => {
    stub = await startHelixStub();
    const credentials = new FakeCredentialPort(); // nothing connected
    const getBearer = helixAccountBearer(credentials, TENANT, { identityUrl: stub.url });
    const client = new CapabilityGatewayClient({ baseUrl: stub.url, getBearer, timeoutMs: 2_000 });
    await expect(client.invoke('data', {})).rejects.toBeInstanceOf(UnentitledError);
  });
});
