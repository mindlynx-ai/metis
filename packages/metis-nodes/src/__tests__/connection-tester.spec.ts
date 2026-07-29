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
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DefaultConnectionTester,
  classifyDbError,
  httpAuthHeaders,
  probeKey,
  resolveHttpProbe,
} from '../connection-tester.js';
import { buildDataSources } from '../register.js';
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

  it('reads a SQL Server refusal in its own vocabulary', () => {
    // A bad password arrives as ELOGIN, and the timeout is ETIMEOUT rather than
    // the ETIMEDOUT every other client spells. Left unclassified, a mistyped
    // password reads as a generic error the operator cannot act on.
    expect(classifyDbError({ code: 'ELOGIN', message: "Login failed for user 'sa'." }).status).toBe(
      'auth_failed',
    );
    expect(classifyDbError({ code: 'ESOCKET', message: 'socket hang up' }).status).toBe('unreachable');
    expect(classifyDbError({ code: 'ETIMEOUT', message: 'timeout' }).status).toBe('unreachable');
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

  it('a wrong password still fails after a good one, through the pooled adapter', async () => {
    // The two cases above go through the bare pg.Client, which opens and closes
    // a connection per probe and so could never have shown the bug. The bug
    // lived on the ADAPTER path, where the probe borrows a cached pool: the key
    // left the password out, so a second probe differing only in password was
    // answered by the first one's already-open pool and read green.
    //
    // Order matters and is the whole point: the good probe must run FIRST so
    // there is a warm pool for the bad one to be wrongly served by.
    const url = new URL(PG_URL!);
    const pooled = new DefaultConnectionTester(buildDataSources());
    const material = {
      host: url.hostname,
      port: url.port,
      database: url.pathname.replace(/^\//, ''),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };

    const good = await pooled.testConnection({
      connectorId: 'postgres',
      authScheme: 'database',
      material,
    });
    expect(good.status).toBe('ok');

    const bad = await pooled.testConnection({
      connectorId: 'postgres',
      authScheme: 'database',
      material: { ...material, password: `${material.password}-wrong` },
    });
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe('auth_failed');
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

  it('gives a different password its own pool, so a wrong one cannot read green', () => {
    // The bug this closes, seen live against a real server: the key named the
    // host, database and user and left the password out, so a second connection
    // that differed only in its password was answered by the first one's open
    // pool and a wrong password passed the test. Same material, same key, so a
    // repeat probe still reuses the pool it opened.
    const good = { host: 'db', database: 'sales', user: 'sa', password: 'right' };
    const bad = { ...good, password: 'wrong' };
    expect(probeKey('sqlserver', good)).not.toBe(probeKey('sqlserver', bad));
    expect(probeKey('sqlserver', good)).toBe(probeKey('sqlserver', { ...good }));
    // And the key never carries the secret it was built from.
    expect(probeKey('sqlserver', good)).not.toContain('right');
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

  it('still sends postgres to the postgres client when no registry was supplied', async () => {
    // A tester built without a DataSourceRegistry is a supported construction,
    // and the PG_URL suite uses it. Narrowing the no-adapter fallback broke
    // exactly this path once; it only failed where PG_URL was set, so it must
    // be pinned somewhere that runs everywhere.
    const health = await new DefaultConnectionTester().testConnection({
      connectorId: 'postgres',
      authScheme: 'database',
      material: { host: '127.0.0.1', port: '1', database: 'd', user: 'u', password: 'p' },
    });
    // No server on port 1, so it cannot be ok. The point is that it reports a
    // connection attempt, not the connect-only refusal.
    expect(health.ok).toBe(false);
    expect(health.message).not.toMatch(/connect-only/i);
  });

  it('says a database engine with no adapter is connect-only rather than guessing', async () => {
    // The old fallback ran a Postgres client at any engine, so the verdict
    // described a protocol the server does not speak: red against the real
    // thing, green against a Postgres box. Neither told the operator anything.
    // This used to name sqlserver, which now HAS an adapter, so it names athena
    // (a Helix-build engine) against the REAL registry: the case then proves
    // the engine is genuinely unadapted rather than assuming it, and says so
    // the day somebody registers one.
    const sources = buildDataSources();
    expect(sources.engines()).not.toContain('athena');
    const health = await new DefaultConnectionTester(sources).testConnection({
      connectorId: 'athena',
      authScheme: 'database',
      baseUrl: 'athena://',
      material: { host: 'db.internal', port: '443', database: 'sales', user: 'u', password: 'p' },
    });
    expect(health.ok).toBe(false);
    expect(health.status).toBe('error');
    expect(health.message).toMatch(/athena/);
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

describe('probing an object store', () => {
  let server: Server;
  let endpoint: string;
  let status = 200;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.statusCode = status;
      // Signed or not, the probe has to reach ListObjectsV2 to learn anything:
      // this records that it did by answering only that path.
      res.end(
        status === 200
          ? '<ListBucketResult><Name>b</Name></ListBucketResult>'
          : '<Error><Code>SignatureDoesNotMatch</Code><Message>no</Message></Error>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  const material = (extra: Record<string, string> = {}) => ({
    connectorId: 's3',
    authScheme: 'sigv4',
    material: {
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'stub-secret',
      region: 'eu-west-1',
      bucket: 'b',
      endpoint,
      allowPrivateEndpoint: 'true',
      ...extra,
    },
  });

  it('reads green when the signed listing is accepted', async () => {
    status = 200;
    const health = await tester.testConnection(material());
    expect(health.status).toBe('ok');
    expect(health.message).toContain('b');
  });

  it('separates a rejected signature from an unreachable store', async () => {
    status = 403;
    expect((await tester.testConnection(material())).status).toBe('auth_failed');
    status = 200;
    const away = await tester.testConnection(material({ endpoint: 'http://127.0.0.1:1' }));
    expect(away.status).toBe('unreachable');
  });

  it('refuses a private endpoint the connection did not name', async () => {
    status = 200;
    const health = await tester.testConnection({
      ...material(),
      material: { ...material().material, allowPrivateEndpoint: 'false' },
    });
    expect(health.status).toBe('error');
    expect(health.message).toMatch(/allowPrivateEndpoint/);
  });

  it('says what is missing rather than probing half a connection', async () => {
    const health = await tester.testConnection({
      connectorId: 's3',
      authScheme: 'sigv4',
      material: { accessKeyId: 'k', secretAccessKey: 's', region: 'eu-west-1' },
    });
    expect(health.status).toBe('error');
    expect(health.message).toMatch(/no bucket/);
  });
});
