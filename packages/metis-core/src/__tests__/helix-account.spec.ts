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
 * The account-connect flow against the stub OIDC, the offers/entitlements
 * surface in both switch positions, the vault posture (bearer stored,
 * never listed), and the consent receipt on the run history (UPL-REQ-13).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  CloudEntitlementsClient,
  FakeCredentialPort,
  FakeExecutionPort,
  OffersClient,
  SingleTenantIdentity,
  startHelixStub,
  STUB_OFFERS,
  helixAccountBearer,
  HELIX_ACCOUNT_CONNECTOR_ID,
  type HelixStub,
} from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { buildCoreServer, type TokenIssuingIdentity } from '../server.js';
import { STATIC_OFFERS } from '../helix-account-routes.js';

async function adminIdentity(): Promise<TokenIssuingIdentity> {
  return SingleTenantIdentity.create('t1', [{ userId: 'jeremy', secret: 'pw', role: 'admin' }]);
}

async function login(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { userId: 'jeremy', secret: 'pw' },
  });
  return (response.json() as { token: string }).token;
}

function freshStore(): WorkflowStore {
  const gateway = new DataGateway(
    new SqliteAdapter(join(mkdtempSync(join(tmpdir(), 'metis-acct-')), 'a.db')),
  );
  registerWorkflowTables(gateway);
  return new WorkflowStore(gateway);
}

describe('connect flow against the stub OIDC', () => {
  let stub: HelixStub;
  let app: FastifyInstance;
  let token: string;
  const credentials = new FakeCredentialPort();

  beforeAll(async () => {
    stub = await startHelixStub({ email: 'jeremy@helix.example', entitled: ['cap.data'] });
    const getBearer = helixAccountBearer(credentials, 't1');
    app = buildCoreServer({
      identity: await adminIdentity(),
      credentials,
      uplift: {
        offers: new OffersClient({ baseUrl: stub.url }),
        entitlements: new CloudEntitlementsClient({ baseUrl: stub.url, getBearer }),
        credentials,
        identityUrl: stub.url,
        redirectBase: 'http://127.0.0.1:4180',
      },
    });
    await app.ready();
    token = await login(app);
  });

  afterAll(async () => {
    await app.close();
    await stub.close();
  });

  it('connect -> authorize -> callback links the account and the bearer works', async () => {
    const connect = await app.inject({
      method: 'POST',
      url: '/api/account/connect',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(connect.statusCode).toBe(200);
    const { authorizeUrl } = connect.json() as { authorizeUrl: string };
    expect(authorizeUrl).toContain('code_challenge_method=S256');

    // Discovery-driven: the endpoint comes from the discovery document
    // (never an assumed /oidc/* path), the scope requests offline_access,
    // and a nonce rides along for id_token binding.
    expect(stub.requests['/.well-known/openid-configuration']).toBeGreaterThanOrEqual(1);
    const authorizeParams = new URL(authorizeUrl).searchParams;
    expect(authorizeUrl.startsWith(`${stub.url}/oidc/authorize?`)).toBe(true);
    expect(authorizeParams.get('scope')).toBe('openid email offline_access');
    expect(authorizeParams.get('nonce')).toBeTruthy();

    // Play the browser: follow the authorize redirect back to the callback.
    const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(authorize.status).toBe(302);
    const back = new URL(authorize.headers.get('location') ?? '');
    const callback = await app.inject({ method: 'GET', url: back.pathname + back.search });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/account?connected=1');

    // The link exists, carries the email, and the vault never lists material.
    const account = await app.inject({
      method: 'GET',
      url: '/api/account',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(account.json()).toEqual({ connected: true, account: { email: 'jeremy@helix.example' } });
    const list = await credentials.listConnections('t1');
    const link = list.find((c) => c.connectorId === HELIX_ACCOUNT_CONNECTOR_ID);
    expect(link).toBeTruthy();
    expect(JSON.stringify(list)).not.toContain('stub_');

    // Rotation-ready vault material: the refresh token and expiry landed.
    const material = await credentials.resolveConnectorCredentials('t1', link?.connectionId ?? '');
    expect(material.refreshToken).toMatch(/^refresh_/);
    expect(Number(material.expiresAt)).toBeGreaterThan(Date.now());

    // Entitlements now read through the linked bearer.
    const entitlements = await app.inject({
      method: 'GET',
      url: '/api/entitlements',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = entitlements.json() as { capabilities: string[]; cloud: string; account: { email: string } };
    expect(body.capabilities).toContain('cap.data');
    expect(body.cloud).toBe('ok');
    expect(body.account?.email).toBe('jeremy@helix.example');
  });

  it('the authorize URL carries the realm client id (metis-editor) by default', async () => {
    // Regression for the live-test finding: the connect flow used to hardcode
    // client_id 'metis', but the realm-as-code ships 'metis-editor'. The
    // default must match the realm so connect works with no extra config.
    const connect = await app.inject({
      method: 'POST',
      url: '/api/account/connect',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(new URL((connect.json() as { authorizeUrl: string }).authorizeUrl).searchParams.get('client_id')).toBe(
      'metis-editor',
    );
  });

  it('offers come back live from the stub manifest', async () => {
    const offers = await app.inject({
      method: 'GET',
      url: '/api/offers',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(offers.json()).toEqual({ capabilities: STUB_OFFERS, source: 'live' });
  });

  it('a bad state on the callback never links anything', async () => {
    const callback = await app.inject({ method: 'GET', url: '/api/account/callback?code=x&state=forged' });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/account?connect=badstate');
  });

  it('disconnect removes the link and entitlements fall to empty', async () => {
    const disconnect = await app.inject({
      method: 'DELETE',
      url: '/api/account',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(disconnect.json()).toEqual({ connected: false });
    const entitlements = await app.inject({
      method: 'GET',
      url: '/api/entitlements',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((entitlements.json() as { capabilities: string[] }).capabilities).toEqual([]);
  });
});

/** One full connect round-trip against a fresh stub + app, returning the landing spot. */
async function connectRoundTrip(stubOptions: Parameters<typeof startHelixStub>[0]) {
  const stub = await startHelixStub({ email: 'jeremy@helix.example', ...stubOptions });
  const credentials = new FakeCredentialPort();
  const getBearer = helixAccountBearer(credentials, 't1', { identityUrl: stub.url });
  const app = buildCoreServer({
    identity: await adminIdentity(),
    credentials,
    uplift: {
      offers: new OffersClient({ baseUrl: stub.url }),
      entitlements: new CloudEntitlementsClient({ baseUrl: stub.url, getBearer }),
      credentials,
      identityUrl: stub.url,
      redirectBase: 'http://127.0.0.1:4180',
    },
  });
  await app.ready();
  const token = await login(app);
  const connect = await app.inject({
    method: 'POST',
    url: '/api/account/connect',
    headers: { authorization: `Bearer ${token}` },
  });
  const { authorizeUrl } = connect.json() as { authorizeUrl: string };
  const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
  const back = new URL(authorize.headers.get('location') ?? '');
  const callback = await app.inject({ method: 'GET', url: back.pathname + back.search });
  return {
    stub,
    app,
    credentials,
    token,
    landedAt: String(callback.headers.location),
    cleanup: async () => {
      await app.close();
      await stub.close();
    },
  };
}

describe('id_token verification (the rejection matrix)', () => {
  it.each([
    ['a wrong nonce', { idTokenClaims: { nonce: 'evil' } }],
    ['a wrong issuer', { idTokenClaims: { iss: 'https://evil.example' } }],
    ['a wrong audience', { idTokenClaims: { aud: 'someone-else' } }],
    ['a bad signature', { tamperIdTokenSignature: true }],
  ])('rejects an id_token with %s and stores nothing', async (_name, knobs) => {
    const round = await connectRoundTrip(knobs);
    expect(round.landedAt).toBe('/account?connect=failed');
    expect(await round.credentials.listConnections('t1')).toEqual([]);
    await round.cleanup();
  });

  it('a good id_token links the account with the email from the VERIFIED claims', async () => {
    // The stub token response carries no convenience email field any more,
    // so this passing proves the email came from the verified id_token.
    const round = await connectRoundTrip({});
    expect(round.landedAt).toBe('/account?connected=1');
    const account = await round.app.inject({
      method: 'GET',
      url: '/api/account',
      headers: { authorization: `Bearer ${round.token}` },
    });
    expect(account.json()).toEqual({ connected: true, account: { email: 'jeremy@helix.example' } });
    await round.cleanup();
  });
});

describe('rotation reuse -> clean disconnected state', () => {
  it('a revoked refresh family reads as disconnected; entitlements degrade to empty', async () => {
    // accessTtlSeconds 30 puts every read inside the 60s refresh skew, so
    // the next bearer use MUST rotate - straight into the revoked family.
    const round = await connectRoundTrip({ accessTtlSeconds: 30 });
    expect(round.landedAt).toBe('/account?connected=1');

    // The attacker replays our refresh token first (rotation theft).
    const link = (await round.credentials.listConnections('t1')).find(
      (c) => c.connectorId === HELIX_ACCOUNT_CONNECTOR_ID,
    );
    const material = await round.credentials.resolveConnectorCredentials('t1', link?.connectionId ?? '');
    await fetch(`${round.stub.url}/oidc/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: material.refreshToken,
        client_id: 'metis',
      }).toString(),
    });

    // Our next refresh presents a rotated token: invalid_grant, family dead,
    // the link cleared - degraded empty entitlements, never a crash.
    const entitlements = await round.app.inject({
      method: 'GET',
      url: '/api/entitlements',
      headers: { authorization: `Bearer ${round.token}` },
    });
    expect((entitlements.json() as { capabilities: string[] }).capabilities).toEqual([]);
    const account = await round.app.inject({
      method: 'GET',
      url: '/api/account',
      headers: { authorization: `Bearer ${round.token}` },
    });
    expect(account.json()).toEqual({ connected: false });
    await round.cleanup();
  });
});

describe('the OIDC client id is configurable (UpliftDeps.clientId)', () => {
  it('threads a configured client id through authorize AND the stub mints aud to match', async () => {
    // A custom client id must flow into the authorize request, and the whole
    // round-trip must still verify - which only holds if the stub mints the
    // id_token aud to the requesting client (as a real IdP does) and verify
    // checks against the SAME configured client id, not a hardcoded 'metis'.
    const stub = await startHelixStub({ email: 'jeremy@helix.example', entitled: ['cap.data'] });
    const credentials = new FakeCredentialPort();
    const getBearer = helixAccountBearer(credentials, 't1', {
      identityUrl: stub.url,
      clientId: 'metis-editor',
    });
    const app = buildCoreServer({
      identity: await adminIdentity(),
      credentials,
      uplift: {
        offers: new OffersClient({ baseUrl: stub.url }),
        entitlements: new CloudEntitlementsClient({ baseUrl: stub.url, getBearer }),
        credentials,
        identityUrl: stub.url,
        redirectBase: 'http://127.0.0.1:4180',
        clientId: 'my-custom-client',
      },
    });
    await app.ready();
    const token = await login(app);

    const connect = await app.inject({
      method: 'POST',
      url: '/api/account/connect',
      headers: { authorization: `Bearer ${token}` },
    });
    const { authorizeUrl } = connect.json() as { authorizeUrl: string };
    expect(new URL(authorizeUrl).searchParams.get('client_id')).toBe('my-custom-client');

    // Full round-trip verifies -> the stub minted aud='my-custom-client' and
    // verifyIdToken accepted it against the configured client id.
    const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
    const back = new URL(authorize.headers.get('location') ?? '');
    const callback = await app.inject({ method: 'GET', url: back.pathname + back.search });
    expect(callback.headers.location).toBe('/account?connected=1');

    await app.close();
    await stub.close();
  });
});

describe('the kill switch (no uplift config)', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = buildCoreServer({ identity: await adminIdentity(), credentials: new FakeCredentialPort() });
    await app.ready();
    token = await login(app);
  });
  afterAll(async () => app.close());

  it('account routes do not exist', async () => {
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'POST', url: '/api/account/connect', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/account', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/account/callback?code=x&state=y' })).statusCode).toBe(404);
  });

  it('offers serve the static bundled view and entitlements read disabled', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const offers = await app.inject({ method: 'GET', url: '/api/offers', headers });
    expect(offers.json()).toEqual({ capabilities: STATIC_OFFERS, source: 'static' });
    const entitlements = await app.inject({ method: 'GET', url: '/api/entitlements', headers });
    expect(entitlements.json()).toMatchObject({ capabilities: [], account: null, cloud: 'disabled' });
  });
});

describe('the consent receipt (UPL-REQ-13)', () => {
  it.each([
    ['allowed', { enabled: true, consentAt: '2026-07-18T09:00:00Z' }, undefined],
    ['allowed', { enabled: true }, true], // per-run consent stamps this run only
    ['kept-local', { enabled: true }, undefined],
  ])('a run with cloud routing on writes decision %s at sequence 1', async (decision, cloudRouting, cloudConsent) => {
    const store = freshStore();
    const app = buildCoreServer({
      identity: await adminIdentity(),
      store,
      executions: new FakeExecutionPort(),
    });
    await app.ready();
    const token = await login(app);
    const definition = {
      nodes: [
        { id: 'a1b2c3d4-1111-4222-8333-444444444444', type: 'webhookconfig', data: { config: {} } },
        { id: 'b1b2c3d4-1111-4222-8333-444444444444', type: 'code', data: { config: { code: 'return 1' } } },
      ],
      edges: [
        {
          source: 'a1b2c3d4-1111-4222-8333-444444444444',
          target: 'b1b2c3d4-1111-4222-8333-444444444444',
        },
      ],
      cloudRouting,
    };
    const started = await app.inject({
      method: 'POST',
      url: '/api/executions',
      headers: { authorization: `Bearer ${token}` },
      payload: { workflowId: 'wf_x', definition, ...(cloudConsent ? { cloudConsent } : {}) },
    });
    expect(started.statusCode).toBe(202);
    const { executionId } = started.json() as { executionId: string };
    // The engine writes META when the run initiates; the fake port doesn't,
    // and getExecution keys off META, so seed it before reading the logs.
    await store.writeExecutionMeta({
      tenantId: 't1',
      executionId,
      workflowId: 'wf_x',
      status: 'running',
      startTime: new Date().toISOString(),
    });
    const execution = await store.getExecution('t1', executionId);
    const receipt = execution?.logs.find((log) => log.event === 'workflow.cloud.routing');
    expect(receipt).toBeTruthy();
    expect(receipt?.sequence).toBe(1);
    expect(receipt?.decision).toBe(decision);
    expect(receipt?.requestedBy).toBe('jeremy');
    if (decision === 'allowed') expect(receipt?.consentAt).toBeTruthy();
    await app.close();
  });

  it('a run without cloud routing writes no receipt', async () => {
    const store = freshStore();
    const app = buildCoreServer({
      identity: await adminIdentity(),
      store,
      executions: new FakeExecutionPort(),
    });
    await app.ready();
    const token = await login(app);
    const started = await app.inject({
      method: 'POST',
      url: '/api/executions',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workflowId: 'wf_x',
        definition: {
          nodes: [
            { id: 'c1b2c3d4-1111-4222-8333-444444444444', type: 'webhookconfig', data: { config: {} } },
            { id: 'd1b2c3d4-1111-4222-8333-444444444444', type: 'code', data: { config: { code: 'return 1' } } },
          ],
          edges: [
            {
              source: 'c1b2c3d4-1111-4222-8333-444444444444',
              target: 'd1b2c3d4-1111-4222-8333-444444444444',
            },
          ],
        },
      },
    });
    expect(started.statusCode).toBe(202);
    const { executionId } = started.json() as { executionId: string };
    await store.writeExecutionMeta({
      tenantId: 't1',
      executionId,
      workflowId: 'wf_x',
      status: 'running',
      startTime: new Date().toISOString(),
    });
    const execution = await store.getExecution('t1', executionId);
    expect(execution?.logs.find((log) => log.event === 'workflow.cloud.routing')).toBeUndefined();
    await app.close();
  });
});
