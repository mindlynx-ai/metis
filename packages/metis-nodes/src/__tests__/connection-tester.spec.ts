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
import { DataSourceRegistry, type DataSource } from '@mindlynx/metis-ports';

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

describe('testing a data engine goes through its own adapter', () => {
  const engine = (name: string, behaviour: (...args: never[]) => Promise<unknown>): DataSource =>
    ({
      engine: name,
      runQuery: behaviour as DataSource['runQuery'],
      listTables: async () => [],
      describeTable: async () => [],
    }) as DataSource;

  const input = (connectorId: string, authScheme: string) => ({
    connectorId,
    authScheme,
    baseUrl: 'https://app.snowflake.com',
    material: { account: 'abc', user: 'u' },
  });

  it('proves snowflake by querying it, not by fetching its console URL', async () => {
    // The trap this closes: a bare GET of app.snowflake.com answers 200 for
    // anyone, so the old path read green with credentials that do not work.
    let asked = '';
    const sources = new DataSourceRegistry().register(
      engine('snowflake', async (_c: unknown, sql: string) => {
        asked = sql;
        return { rows: [{ '1': 1 }], rowCount: 1, truncated: false };
      }) as DataSource,
    );
    const health = await new DefaultConnectionTester(sources).testConnection(
      input('snowflake', 'bearer'),
    );
    expect(health.ok).toBe(true);
    expect(asked).toMatch(/select 1/i);
  });

  it('reports a refused login as auth_failed, not a generic error', async () => {
    const sources = new DataSourceRegistry().register(
      engine('snowflake', async () => {
        throw new Error('snowflake: JWT token is invalid');
      }) as DataSource,
    );
    const health = await new DefaultConnectionTester(sources).testConnection(
      input('snowflake', 'bearer'),
    );
    expect(health.ok).toBe(false);
    expect(health.status).toBe('auth_failed');
  });

  it('sends mysql to the mysql adapter rather than a postgres client', async () => {
    let engineUsed = '';
    const sources = new DataSourceRegistry().register(
      engine('mysql', async () => {
        engineUsed = 'mysql';
        return { rows: [], rowCount: 0, truncated: false };
      }) as DataSource,
    );
    const health = await new DefaultConnectionTester(sources).testConnection(
      input('mysql', 'database'),
    );
    expect(engineUsed).toBe('mysql');
    expect(health.ok).toBe(true);
  });

  it('says a database engine with no adapter is connect-only rather than guessing', async () => {
    // sqlserver has a catalogue record but no adapter. The old fallback ran a
    // Postgres client against it, so the verdict described a protocol the
    // server does not speak: red against a real SQL Server, green against a
    // Postgres box. Neither told the operator anything true.
    const sources = new DataSourceRegistry();
    const health = await new DefaultConnectionTester(sources).testConnection({
      connectorId: 'sqlserver',
      authScheme: 'database',
      baseUrl: 'sqlserver://',
      material: { host: 'db.internal', port: '1433', database: 'sales', user: 'u', password: 'p' },
    });
    expect(health.ok).toBe(false);
    expect(health.status).toBe('error');
    expect(health.message).toMatch(/sqlserver/);
    expect(health.message).toMatch(/connect-only/i);
  });

  it('still probes an ordinary http connector over http', async () => {
    // No adapter for this connector, so nothing changes for the other 99.
    const sources = new DataSourceRegistry();
    const health = await new DefaultConnectionTester(sources).testConnection({
      connectorId: 'github',
      authScheme: 'bearer',
      material: { token: 't' },
    });
    // No base URL to probe, which is the http path's own complaint.
    expect(health.ok).toBe(false);
    expect(health.message).toMatch(/base URL/i);
  });
});
