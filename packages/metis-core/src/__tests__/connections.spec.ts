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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  SingleTenantIdentity,
  FakeCredentialPort,
  type ConnectionTester,
  type ConnectionTestInput,
} from '@mindlynx/metis-ports';
import { buildCoreServer } from '../server.js';

describe('connections (named connector instances)', () => {
  let app: FastifyInstance;
  const credentials = new FakeCredentialPort();
  let admin: string;
  let viewer: string;

  beforeAll(async () => {
    const identity = await SingleTenantIdentity.create('t1', [
      { userId: 'jeremy', secret: 'pw', role: 'admin' },
      { userId: 'watcher', secret: 'pw', role: 'viewer' },
    ]);
    app = buildCoreServer({ identity, credentials });
    await app.ready();
    const login = async (userId: string) =>
      (
        (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId, secret: 'pw' } })).json() as {
          token: string;
        }
      ).token;
    admin = await login('jeremy');
    viewer = await login('watcher');
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, token = admin) =>
    app.inject({ method, url, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${token}` } });

  it('creates, lists, resolves and deletes a named connection', async () => {
    expect((await call('GET', '/api/connections')).json()).toEqual({ connections: [] });

    const created = await call('POST', '/api/connections', {
      name: 'My GitHub',
      connectorId: 'github',
      material: { token: 'ghp_secret' },
    });
    expect(created.statusCode).toBe(201);
    const { connectionId } = created.json() as { connectionId: string };
    expect(connectionId).toMatch(/^conn_/);

    // Listed with its name + type, never the material.
    const list = (await call('GET', '/api/connections')).json() as {
      connections: { connectionId: string; name: string; connectorId: string }[];
    };
    expect(list.connections).toHaveLength(1);
    expect(list.connections[0]).toMatchObject({ connectionId, name: 'My GitHub', connectorId: 'github' });
    expect(JSON.stringify(list)).not.toContain('ghp_secret');
    // Material is resolvable server-side (for the node handlers).
    expect(await credentials.resolveConnectorCredentials('t1', connectionId)).toEqual({ token: 'ghp_secret' });

    // Rename.
    expect((await call('PATCH', `/api/connections/${connectionId}`, { name: 'GitHub Prod' })).statusCode).toBe(204);
    const renamed = (await call('GET', '/api/connections')).json() as { connections: { name: string }[] };
    expect(renamed.connections[0].name).toBe('GitHub Prod');

    // Rotate the credentials (edit): the material is replaced, the name kept.
    expect((await call('PATCH', `/api/connections/${connectionId}`, { material: { token: 'ghp_rotated' } })).statusCode).toBe(204);
    expect(await credentials.resolveConnectorCredentials('t1', connectionId)).toEqual({ token: 'ghp_rotated' });
    expect(((await call('GET', '/api/connections')).json() as { connections: { name: string }[] }).connections[0].name).toBe('GitHub Prod');

    // Delete.
    expect((await call('DELETE', `/api/connections/${connectionId}`)).statusCode).toBe(204);
    expect((await call('GET', '/api/connections')).json()).toEqual({ connections: [] });
  });

  it('exposes non-secret values for editing and merges material (Stripe is multi-field)', async () => {
    const created = await call('POST', '/api/connections', {
      name: 'Stripe',
      connectorId: 'stripe',
      material: { secretKey: 'sk_1', publishableKey: 'pk_1', webhookSecret: 'whsec_1' },
    });
    const { connectionId } = created.json() as { connectionId: string };

    // GET returns ONLY non-secret fields (publishable key); secrets never leave.
    const got = (await call('GET', `/api/connections/${connectionId}`)).json() as {
      values: Record<string, string>;
    };
    expect(got.values).toEqual({ publishableKey: 'pk_1' });
    expect(JSON.stringify(got)).not.toContain('sk_1');
    expect(JSON.stringify(got)).not.toContain('whsec_1');

    // Editing ONE field merges: rotate the secret key, the others survive.
    expect(
      (await call('PATCH', `/api/connections/${connectionId}`, { material: { secretKey: 'sk_2' } })).statusCode,
    ).toBe(204);
    expect(await credentials.resolveConnectorCredentials('t1', connectionId)).toEqual({
      secretKey: 'sk_2',
      publishableKey: 'pk_1',
      webhookSecret: 'whsec_1',
    });

    await call('DELETE', `/api/connections/${connectionId}`);
  });

  it('allows several named connections of the same connector type', async () => {
    const a = (await call('POST', '/api/connections', {
      name: 'SendGrid Prod',
      connectorId: 'sendgrid',
      material: { apiKey: 'k1' },
    })).json() as { connectionId: string };
    const b = (await call('POST', '/api/connections', {
      name: 'SendGrid Test',
      connectorId: 'sendgrid',
      material: { apiKey: 'k2' },
    })).json() as { connectionId: string };
    expect(a.connectionId).not.toBe(b.connectionId);
    const list = (await call('GET', '/api/connections')).json() as {
      connections: { connectorId: string; name: string }[];
    };
    const sendgrids = list.connections.filter((c) => c.connectorId === 'sendgrid');
    expect(sendgrids.map((c) => c.name).sort()).toEqual(['SendGrid Prod', 'SendGrid Test']);
    for (const id of [a.connectionId, b.connectionId]) await call('DELETE', `/api/connections/${id}`);
  });

  it('rejects an invalid body and a viewer write', async () => {
    expect((await call('POST', '/api/connections', { name: 'x' })).statusCode).toBe(400);
    expect(
      (await call('POST', '/api/connections', { name: 'x', connectorId: 'github', material: { k: 'v' } }, viewer))
        .statusCode,
    ).toBe(403);
  });
});

describe('connection health (test endpoint)', () => {
  let app: FastifyInstance;
  const credentials = new FakeCredentialPort();
  const tester: ConnectionTester & { last?: ConnectionTestInput } = {
    async testConnection(input) {
      tester.last = input;
      return { status: 'ok', ok: true, message: 'stub', checkedAt: '2026-01-01T00:00:00.000Z' };
    },
  };
  let token: string;

  beforeAll(async () => {
    const identity = await SingleTenantIdentity.create('t1', [{ userId: 'jeremy', secret: 'pw', role: 'admin' }]);
    app = buildCoreServer({ identity, credentials, connectionTester: tester });
    await app.ready();
    token = (
      (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: 'jeremy', secret: 'pw' } })).json() as {
        token: string;
      }
    ).token;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('404s an unknown connection', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/connections/nope/test', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(404);
  });

  it('tests a connection with its type scheme, baseUrl and resolved material', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'GitHub Prod', connectorId: 'github', material: { token: 'ghp_secret' } },
      })
    ).json() as { connectionId: string };

    const res = await app.inject({
      method: 'POST',
      url: `/api/connections/${created.connectionId}/test`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json()).toMatchObject({ ok: true, status: 'ok' });
    expect(tester.last).toMatchObject({
      connectorId: 'github',
      authScheme: 'bearer',
      material: { token: 'ghp_secret' },
    });
    expect(tester.last?.baseUrl).toMatch(/^https?:\/\//);
  });

  it('reports the reserved helix-account link healthy without probing (no base URL to test)', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'jeremy@example.com',
          connectorId: 'helix-account',
          material: { refreshToken: 'rt_x', accessToken: 'at_x' },
        },
      })
    ).json() as { connectionId: string };

    tester.last = undefined;
    const res = await app.inject({
      method: 'POST',
      url: `/api/connections/${created.connectionId}/test`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json()).toMatchObject({ ok: true, status: 'ok', message: 'Helix account linked' });
    // The generic tester must NOT have been called - there is nothing to probe.
    expect(tester.last).toBeUndefined();
  });

  it('tests raw material without saving (the create-connection modal path)', async () => {
    const count = async () =>
      (
        (await app.inject({ method: 'GET', url: '/api/connections', headers: { authorization: `Bearer ${token}` } })).json() as {
          connections: unknown[];
        }
      ).connections.length;
    const before = await count();

    const res = await app.inject({
      method: 'POST',
      url: '/api/connections/test',
      headers: { authorization: `Bearer ${token}` },
      payload: { connectorId: 'github', material: { token: 'ghp_unsaved' } },
    });
    expect(res.json()).toMatchObject({ ok: true, status: 'ok' });
    // The connector's scheme/baseUrl fill in; material passes through unsaved.
    expect(tester.last).toMatchObject({
      connectorId: 'github',
      authScheme: 'bearer',
      material: { token: 'ghp_unsaved' },
    });
    // A test never persists a connection.
    expect(await count()).toBe(before);
  });
});
