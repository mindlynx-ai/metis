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
 * The sign-in route was unthrottled, and there was no way to sign out.
 * Real clock throughout - the windows here are sub-second on purpose, because
 * faking timers under Fastify's own timers is a worse trade than waiting.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SingleTenantIdentity } from '@mindlynx/metis-ports';
import { buildCoreServer } from '../server.js';
import { DEFAULT_LOGIN_LIMIT, type LoginLimitPolicy } from '../login-rate-limit.js';

const SEEDS = [{ userId: 'jeremy', secret: 'pw', role: 'admin' as const }];

let app: FastifyInstance;
let identity: SingleTenantIdentity;

async function boot(loginLimit?: LoginLimitPolicy) {
  identity = await SingleTenantIdentity.create('t1', SEEDS);
  app = buildCoreServer({ identity, loginLimit });
  await app.ready();
}

const signIn = (secret: string, remoteAddress = '10.0.0.1') =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { userId: 'jeremy', secret },
    remoteAddress,
  });

afterEach(async () => {
  await app?.close();
});

describe('login throttle', () => {
  it('trips after the configured failures and refuses even the right secret', async () => {
    await boot({ attempts: 3, windowMinutes: 15 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await signIn('wrong')).statusCode).toBe(401);
    }

    expect((await signIn('wrong')).statusCode).toBe(429);
    // The right secret too, or the limit would only be metering typos.
    expect((await signIn('pw')).statusCode).toBe(429);
  });

  it('recovers once the window passes', async () => {
    // 0.01 minutes = 600ms. A real wait, so no fake clock has to agree with
    // Fastify's own timers.
    await boot({ attempts: 2, windowMinutes: 0.01 });

    await signIn('wrong');
    await signIn('wrong');
    expect((await signIn('pw')).statusCode).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect((await signIn('pw')).statusCode).toBe(200);
  });

  it('does not let one attacker lock a user out of another address', async () => {
    await boot({ attempts: 2, windowMinutes: 15 });

    await signIn('wrong', '10.0.0.66');
    await signIn('wrong', '10.0.0.66');
    expect((await signIn('pw', '10.0.0.66')).statusCode).toBe(429);

    // Same account, the victim's own address: a separate bucket.
    expect((await signIn('pw', '10.0.0.1')).statusCode).toBe(200);
  });

  it('clears the count on a successful sign-in', async () => {
    await boot({ attempts: 3, windowMinutes: 15 });

    await signIn('wrong');
    await signIn('wrong');
    expect((await signIn('pw')).statusCode).toBe(200);

    // Back to a full allowance, not one guess from a lockout.
    expect((await signIn('wrong')).statusCode).toBe(401);
    expect((await signIn('wrong')).statusCode).toBe(401);
    expect((await signIn('wrong')).statusCode).toBe(401);
  });

  it('defaults to a limit rather than to none', async () => {
    expect(DEFAULT_LOGIN_LIMIT.attempts).toBeLessThanOrEqual(20);
    expect(DEFAULT_LOGIN_LIMIT.windowMinutes).toBeGreaterThan(0);

    await boot();
    for (let attempt = 0; attempt < DEFAULT_LOGIN_LIMIT.attempts; attempt += 1) {
      expect((await signIn('wrong')).statusCode).toBe(401);
    }
    expect((await signIn('wrong')).statusCode).toBe(429);
  });
});

describe('logout', () => {
  beforeEach(async () => {
    await boot();
  });

  const token = async () =>
    ((await signIn('pw')).json() as { token: string }).token;

  const me = (bearer: string) =>
    app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${bearer}` } });

  const logout = (bearer: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${bearer}` },
    });

  it('revokes the token immediately, not at the next sweep', async () => {
    const bearer = await token();
    expect((await me(bearer)).statusCode).toBe(200);

    expect((await logout(bearer)).statusCode).toBe(204);
    expect((await me(bearer)).statusCode).toBe(401);
    expect(identity.sessionCount).toBe(0);
  });

  it('leaves this session’s other tokens alone', async () => {
    const first = await token();
    const second = await token();

    await logout(first);
    expect((await me(first)).statusCode).toBe(401);
    expect((await me(second)).statusCode).toBe(200);
  });

  it('refuses an anonymous logout', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(401);
  });
});
