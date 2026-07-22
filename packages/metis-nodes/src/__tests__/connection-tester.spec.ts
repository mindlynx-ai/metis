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
 * The connection tester: its verdict classification (the valuable logic) is
 * unit-tested pure; the real database SELECT 1 gates on PG_URL and the real
 * http probe on NET_TEST, so `npm test` stays hermetic.
 */
import { describe, it, expect } from 'vitest';
import {
  DefaultConnectionTester,
  classifyDbError,
  httpAuthHeaders,
  resolveHttpProbe,
} from '../connection-tester.js';

const tester = new DefaultConnectionTester();

describe('connection tester classification', () => {
  it('separates auth failure from unreachable from error (postgres codes)', () => {
    expect(classifyDbError({ code: '28P01', message: 'bad password' }).status).toBe('auth_failed');
    expect(classifyDbError({ code: '3D000', message: 'no such db' }).status).toBe('auth_failed');
    expect(classifyDbError({ code: 'ECONNREFUSED', message: 'refused' }).status).toBe('unreachable');
    expect(classifyDbError({ code: 'ENOTFOUND', message: 'dns' }).status).toBe('unreachable');
    expect(classifyDbError({ message: 'something else' }).status).toBe('error');
  });

  it('builds auth headers per scheme', () => {
    expect(
      httpAuthHeaders({ connectorId: 'x', authScheme: 'bearer', material: { token: 't' } }),
    ).toEqual({ authorization: 'Bearer t' });
    expect(
      httpAuthHeaders({
        connectorId: 'x',
        authScheme: 'header',
        authHeaderName: 'xc-token',
        material: { apiKey: 'k' },
      }),
    ).toEqual({ 'xc-token': 'k' });
    expect(
      httpAuthHeaders({ connectorId: 'x', authScheme: 'basic', material: { user: 'u', password: 'p' } })
        .authorization,
    ).toMatch(/^Basic /);
  });

  it('resolves the http probe: bare GET by default, the custom healthCheck otherwise', () => {
    // Default: a bare GET of the base URL.
    expect(
      resolveHttpProbe({ connectorId: 'x', authScheme: 'bearer', baseUrl: 'https://api.x.com', material: {} }),
    ).toEqual({ url: 'https://api.x.com', method: 'GET' });
    // Custom probe (Resend): POST a path relative to the base URL with a JSON body.
    expect(
      resolveHttpProbe({
        connectorId: 'resend',
        authScheme: 'bearer',
        baseUrl: 'https://api.resend.com',
        healthCheck: { method: 'POST', path: '/emails', body: {} },
        material: {},
      }),
    ).toEqual({ url: 'https://api.resend.com/emails', method: 'POST', body: '{}' });
    // Nothing to probe without a base URL.
    expect(resolveHttpProbe({ connectorId: 'x', authScheme: 'bearer', material: {} })).toBe(
      'connector has no base URL to probe',
    );
  });

  it('a "none" connector is always ok', async () => {
    const health = await tester.testConnection({ connectorId: 'x', authScheme: 'none', material: {} });
    expect(health.ok).toBe(true);
    expect(health.status).toBe('ok');
    expect(health.checkedAt).toBeTruthy();
  });

  it('an http connector with no base url errors rather than throws', async () => {
    const health = await tester.testConnection({
      connectorId: 'x',
      authScheme: 'bearer',
      material: { token: 't' },
    });
    expect(health.status).toBe('error');
  });
});

const PG_URL = process.env.PG_URL;
describe.skipIf(!PG_URL)('connection tester: real database (PG_URL)', () => {
  it('SELECT 1 succeeds on a good connection string', async () => {
    const health = await tester.testConnection({
      connectorId: 'postgres',
      authScheme: 'database',
      material: { connectionString: PG_URL! },
    });
    expect(health.status).toBe('ok');
  });

  it('a wrong password is reported as auth_failed', async () => {
    const broken = PG_URL!.replace(/:\/\/([^:]+):[^@]*@/, '://$1:wrongpw@');
    const health = await tester.testConnection({
      connectorId: 'postgres',
      authScheme: 'database',
      material: { connectionString: broken },
    });
    expect(['auth_failed', 'unreachable']).toContain(health.status);
    expect(health.ok).toBe(false);
  });
});

describe.skipIf(process.env.NET_TEST !== '1')('connection tester: real http (NET_TEST)', () => {
  it('a reachable public endpoint reads ok (probes with an auth header)', async () => {
    const health = await tester.testConnection({
      connectorId: 'jsonplaceholder',
      authScheme: 'header',
      authHeaderName: 'x-api-key',
      baseUrl: 'https://jsonplaceholder.typicode.com/',
      material: { apiKey: 'ignored-by-this-service' },
    });
    expect(health.ok).toBe(true);
  });

  it('an unresolvable host is not ok (unreachable or error, never a pass)', async () => {
    const health = await tester.testConnection({
      connectorId: 'nope',
      authScheme: 'bearer',
      baseUrl: 'https://this-host-does-not-exist.metis-test.invalid/',
      material: { token: 't' },
    });
    expect(health.ok).toBe(false);
    expect(['unreachable', 'error']).toContain(health.status);
  });
});
