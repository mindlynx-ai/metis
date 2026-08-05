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
 * The two reads that handed back stored credential material.
 *
 * Both halves are tested for each: the guard (a viewer is refused, an editor
 * is not, so the guard is not simply off) and the projection (the material is
 * absent from the body even for the caller who is allowed the read). The
 * projection is the part that matters: a read endpoint that returns a stored
 * secret is a defect whoever is asking, and a guard alone would only narrow
 * the audience for it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SingleTenantIdentity, FakeCredentialPort } from '@mindlynx/metis-ports';
import { buildCoreServer } from '../server.js';
import type { TriggersPort } from '../trigger-mgmt-routes.js';

const USERS = [
  { userId: 'jeremy', secret: 'pw', role: 'admin' as const },
  { userId: 'ed', secret: 'pw', role: 'editor' as const },
  { userId: 'watcher', secret: 'pw', role: 'viewer' as const },
];

const login = async (app: FastifyInstance, userId: string) =>
  (
    (
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId, secret: 'pw' } })
    ).json() as { token: string }
  ).token;

describe('GET /api/triggers', () => {
  // A webhook's shared signing secret. With the trigger id beside it, it is
  // everything needed to sign a delivery the workflow will accept.
  const HOOK_SECRET = 'whsec_signs_a_delivery_the_workflow_accepts';
  let app: FastifyInstance;
  let editor: string;
  let viewer: string;

  const triggers: TriggersPort = {
    list: () =>
      Promise.resolve([
        {
          triggerId: 'trg-hook',
          tenantId: 't1',
          kind: 'webhook',
          workflowId: 'wf-billing',
          enabled: true,
          verification: 'hmac',
          secret: HOOK_SECRET,
        },
      ]),
    create: (input) => Promise.resolve({ triggerId: 'trg-1', ...input }),
    remove: () => Promise.resolve(),
    setSecret: () => Promise.resolve(true),
  };

  beforeAll(async () => {
    const identity = await SingleTenantIdentity.create('t1', USERS);
    app = buildCoreServer({ identity, triggers });
    await app.ready();
    editor = await login(app, 'ed');
    viewer = await login(app, 'watcher');
  });

  afterAll(async () => {
    await app?.close();
  });

  const list = (token: string) =>
    app.inject({ method: 'GET', url: '/api/triggers', headers: { authorization: `Bearer ${token}` } });

  it('is closed to a viewer, like every other route in the file', async () => {
    expect((await list(viewer)).statusCode).toBe(403);
  });

  it('still opens for an editor', async () => {
    expect((await list(editor)).statusCode).toBe(200);
  });

  it('never returns the webhook secret, not even to the editor', async () => {
    const response = await list(editor);
    expect(response.body).not.toContain(HOOK_SECRET);
    const { items } = response.json() as { items: Record<string, unknown>[] };
    expect(items[0]).not.toHaveProperty('secret');
    // The rest of the row is what the list is for, and still arrives.
    expect(items[0]).toMatchObject({
      triggerId: 'trg-hook',
      kind: 'webhook',
      workflowId: 'wf-billing',
      enabled: true,
      verification: 'hmac',
    });
  });
});

describe('GET /api/connections/:id', () => {
  let app: FastifyInstance;
  let admin: string;
  let editor: string;
  let viewer: string;
  let accountId: string;
  let stripeId: string;

  beforeAll(async () => {
    const identity = await SingleTenantIdentity.create('t1', USERS);
    app = buildCoreServer({ identity, credentials: new FakeCredentialPort() });
    await app.ready();
    admin = await login(app, 'jeremy');
    editor = await login(app, 'ed');
    viewer = await login(app, 'watcher');
    const create = async (payload: Record<string, unknown>) =>
      (
        (
          await app.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { authorization: `Bearer ${admin}` },
            payload,
          })
        ).json() as { connectionId: string }
      ).connectionId;
    // The Helix account link: an OAuth grant to the operator's own account,
    // stored as ordinary connection material.
    accountId = await create({
      name: 'jeremy@example.com',
      connectorId: 'helix-account',
      authScheme: 'bearer',
      material: { accessToken: 'at_live', refreshToken: 'rt_live', expiresAt: '1780000000000' },
    });
    // A connector the catalogue does know, to prove the edit form still fills.
    stripeId = await create({
      name: 'Stripe',
      connectorId: 'stripe',
      material: { secretKey: 'sk_live', publishableKey: 'pk_live' },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  const get = (id: string, token: string) =>
    app.inject({
      method: 'GET',
      url: `/api/connections/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it('is closed to a viewer: this is the endpoint behind the edit form', async () => {
    expect((await get(accountId, viewer)).statusCode).toBe(403);
  });

  it('still opens for an editor', async () => {
    expect((await get(stripeId, editor)).statusCode).toBe(200);
  });

  it('never returns the account tokens, not even to the editor', async () => {
    const response = await get(accountId, editor);
    expect(response.body).not.toContain('rt_live');
    expect(response.body).not.toContain('at_live');
  });

  it('still fills the edit form with the values that are not secret', async () => {
    const { values } = (await get(stripeId, editor)).json() as { values: Record<string, string> };
    expect(values).toEqual({ publishableKey: 'pk_live' });
  });

  it('leaves the metadata list open, and it carries no material', async () => {
    // A viewer opening a workflow needs a connection's NAME to render the node
    // that uses it, and the list is metadata only, so this one stays readable.
    const response = await app.inject({
      method: 'GET',
      url: '/api/connections',
      headers: { authorization: `Bearer ${viewer}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('rt_live');
    expect(response.body).not.toContain('sk_live');
  });
});
