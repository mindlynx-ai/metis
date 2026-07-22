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
import { SingleTenantIdentity } from '@mindlynx/metis-ports';
import { buildCoreServer } from '../server.js';
import { requireAction } from '../auth-gate.js';
import { EntitlementsShim } from '../entitlements.js';

describe('metis-core auth and entitlements', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    const identity = await SingleTenantIdentity.create('t1', [
      { userId: 'jeremy', secret: 'pw', role: 'admin' },
      { userId: 'watcher', secret: 'pw', role: 'viewer' },
    ]);
    app = buildCoreServer({
      identity,
      entitlements: new EntitlementsShim(),
    });
    app.register(async (authed) => {
      authed.addHook('onRequest', async (request, reply) => {
        const header = request.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
        const session = token ? await identity.verify(token) : undefined;
        if (!session) {
          await reply.code(401).send({ error: 'unauthorised' });
          return reply;
        }
        request.session = session;
      });
      authed.post('/api/probe/edit', { preHandler: requireAction('edit') }, async (_req, reply) =>
        reply.send({ edited: true }),
      );
      authed.get('/api/probe/view', { preHandler: requireAction('view') }, async (_req, reply) =>
        reply.send({ viewed: true }),
      );
    });
    await app.ready();

    const login = async (userId: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { userId, secret: 'pw' },
      });
      return (response.json() as { token: string }).token;
    };
    adminToken = await login('jeremy');
    viewerToken = await login('watcher');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('logs in with valid credentials and rejects bad ones', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { userId: 'jeremy', secret: 'wrong' },
    });
    expect(bad.statusCode).toBe(401);
    expect(adminToken).toBeTruthy();
  });

  it('an authenticated session can read itself; anonymous calls are refused', async () => {
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect((me.json() as { userId: string; role: string }).role).toBe('admin');

    const anonymous = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('roles gate edit vs view', async () => {
    const viewerEdit = await app.inject({
      method: 'POST',
      url: '/api/probe/edit',
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(viewerEdit.statusCode).toBe(403);

    const viewerView = await app.inject({
      method: 'GET',
      url: '/api/probe/view',
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(viewerView.statusCode).toBe(200);

    const adminEdit = await app.inject({
      method: 'POST',
      url: '/api/probe/edit',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminEdit.statusCode).toBe(200);
  });

  it('reports the open entitlements and ignores fake paid claims', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/entitlements',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const report = response.json() as { edition: string; entitlements: Record<string, boolean> };
    expect(report.edition).toBe('open');
    expect(report.entitlements.workflows).toBe(true);
    expect(report.entitlements['cortex-memory']).toBeUndefined();
    expect(new EntitlementsShim().isEnabled('cortex-memory')).toBe(false);
  });
});
