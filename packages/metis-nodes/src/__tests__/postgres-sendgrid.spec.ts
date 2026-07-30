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
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_MAX_ROWS, FakeCredentialPort, nodeCtx, nodeOutput } from '@mindlynx/metis-ports';
import { createPostgresNodeHandler } from '../postgres-node.js';
import { closePostgresPools } from '../postgres-pool.js';
import { createSendgridNodeHandler } from '../sendgrid-node.js';

const request = (type: string, config: Record<string, unknown>) => nodeCtx(type, config);

const pgUrl = process.env.PG_URL;
if (!pgUrl && process.env.CI) {
  throw new Error('PG_URL must be set in CI so the postgres node spec cannot silently skip');
}

if (pgUrl) {
  describe('postgres node', () => {
    const credentials = new FakeCredentialPort(
      {},
      { 't1/pg-main': { name: 'pg-main', connectorId: 'postgres', material: { connectionString: pgUrl } } },
    );
    const handler = createPostgresNodeHandler(credentials);

    afterAll(async () => {
      await closePostgresPools();
    });

    it('runs a parameterised query through connector credentials', async () => {
      const result = await handler(
        request('postgres', {
          connectorId: 'pg-main',
          query: 'SELECT $1::int AS n, $2::text AS label',
          params: [7, 'metis'],
        }),
      );
      expect(result.status).toBe(200);
      const output = nodeOutput(result) as { rows: Record<string, unknown>[]; rowCount: number };
      expect(output.rows).toEqual([{ n: 7, label: 'metis' }]);
      expect(output.rowCount).toBe(1);
    });

    // `SELECT * FROM orders` is the first query anyone types, and the whole
    // result set used to ride into the workflow payload unbounded.
    it('caps a large result set at the shared DataSource ceiling', async () => {
      const result = await handler(
        request('postgres', {
          connectorId: 'pg-main',
          query: `SELECT generate_series(1, ${DEFAULT_MAX_ROWS + 500}) AS n`,
        }),
      );
      expect(result.status).toBe(200);
      const output = nodeOutput(result) as {
        rows: Record<string, unknown>[];
        rowCount: number;
        truncated?: boolean;
        totalRows?: number;
      };
      expect(output.rows).toHaveLength(DEFAULT_MAX_ROWS);
      expect(output.rowCount).toBe(DEFAULT_MAX_ROWS);
      expect(output.truncated).toBe(true);
      expect(output.totalRows).toBe(DEFAULT_MAX_ROWS + 500);
    });

    it('leaves a write alone: rowCount stays rows affected, nothing is truncated', async () => {
      const table = `metis_cap_${Date.now()}`;
      await handler(request('postgres', { connectorId: 'pg-main', query: `CREATE TABLE ${table} (id int)` }));
      const inserted = await handler(
        request('postgres', {
          connectorId: 'pg-main',
          query: `INSERT INTO ${table} SELECT generate_series(1, ${DEFAULT_MAX_ROWS + 500})`,
        }),
      );
      const output = nodeOutput(inserted) as { rowCount: number; truncated?: boolean };
      expect(output.rowCount).toBe(DEFAULT_MAX_ROWS + 500);
      expect(output.truncated).toBeUndefined();
      await handler(request('postgres', { connectorId: 'pg-main', query: `DROP TABLE ${table}` }));
    });

    it('fails cleanly on SQL errors without leaking credentials', async () => {
      const result = await handler(
        request('postgres', { connectorId: 'pg-main', query: 'SELECT * FROM no_such_table_xyz' }),
      );
      expect(result.status).not.toBe(200);
      expect(result.message).toMatch(/no_such_table_xyz/);
      expect(JSON.stringify(result)).not.toContain(pgUrl);
    });

    it('fails when the connector has no credentials', async () => {
      const result = await handler(
        request('postgres', { connectorId: 'missing', query: 'SELECT 1' }),
      );
      expect(result.status).not.toBe(200);
      expect(result.message).toMatch(/credentials/i);
    });

    it('runs the visual query-builder (insert then select) end to end', async () => {
      const table = `metis_builder_${Date.now()}`;
      // Set up a scratch table with the raw path.
      const setup = await handler(
        request('postgres', {
          connectorId: 'pg-main',
          query: `CREATE TABLE ${table} (id int primary key, tier text)`,
        }),
      );
      expect(setup.status).toBe(200);

      // Insert via the builder (operation + tables.values).
      const inserted = await handler(
        request('postgres', {
          connectorId: 'pg-main',
          operation: 'insert',
          tables: [{ name: table, values: { id: 1, tier: 'gold' } }],
        }),
      );
      expect(inserted.status).toBe(200);

      // Select via the builder (operation + where + orderBy).
      const selected = await handler(
        request('postgres', {
          connectorId: 'pg-main',
          operation: 'select',
          tables: [{ name: table, columns: [{ name: 'id' }, { name: 'tier' }] }],
          where: [{ column: 'tier', operator: '=', value: 'gold' }],
        }),
      );
      expect(selected.status).toBe(200);
      const output = nodeOutput(selected) as { rows: Record<string, unknown>[] };
      expect(output.rows).toEqual([{ id: 1, tier: 'gold' }]);

      await handler(request('postgres', { connectorId: 'pg-main', query: `DROP TABLE ${table}` }));
    });
  });
} else {
  describe('postgres node (PG_URL not set)', () => {
    it('is only allowed to stand down outside CI', () => {
      expect(process.env.CI).toBeUndefined();
    });
  });
}

describe('sendgrid node', () => {
  let server: Server;
  let baseUrl: string;
  const seen: { auth?: string; body?: unknown }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        res.statusCode = 202;
        res.end('');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('sends mail with the connector api key resolved at the CredentialPort boundary', async () => {
    const credentials = new FakeCredentialPort(
      {},
      {
        't1/sendgrid-main': {
          name: 'sendgrid-main',
          connectorId: 'sendgrid',
          material: { apiKey: 'SG.super-secret-key' },
        },
      },
    );
    const handler = createSendgridNodeHandler(credentials, { baseUrl });
    const result = await handler(
      request('sendgrid', {
        connectorId: 'sendgrid-main',
        to: 'someone@example.test',
        from: 'metis@example.test',
        subject: 'hello',
        text: 'from the open build',
      }),
    );
    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.auth).toBe('Bearer SG.super-secret-key');
    const payload = seen[0]?.body as Record<string, unknown>;
    expect((payload.personalizations as { to: { email: string }[] }[])[0]?.to[0]?.email).toBe(
      'someone@example.test',
    );
    expect(JSON.stringify(result)).not.toContain('SG.super-secret-key');
  });

  it('fails when the provider rejects the send', async () => {
    const credentials = new FakeCredentialPort(
      {},
      { 't1/sendgrid-main': { name: 'sendgrid-main', connectorId: 'sendgrid', material: { apiKey: 'k' } } },
    );
    const rejecting = createServer((req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ errors: [{ message: 'bad key' }] }));
    });
    await new Promise<void>((resolve) => rejecting.listen(0, '127.0.0.1', resolve));
    const rejectingUrl = `http://127.0.0.1:${(rejecting.address() as AddressInfo).port}`;
    const handler = createSendgridNodeHandler(credentials, { baseUrl: rejectingUrl });
    const result = await handler(
      request('sendgrid', {
        connectorId: 'sendgrid-main',
        to: 'a@b.test',
        from: 'c@d.test',
        subject: 's',
        text: 't',
      }),
    );
    expect(result.status).not.toBe(200);
    expect(result.message).toMatch(/401/);
    rejecting.close();
  });

  it('gives up on a send that stalls instead of holding the activity open', async () => {
    const credentials = new FakeCredentialPort(
      {},
      { 't1/sendgrid-main': { name: 'sendgrid-main', connectorId: 'sendgrid', material: { apiKey: 'k' } } },
    );
    // The routine failure: the edge accepts the connection and then says
    // nothing. Without a ceiling this promise stayed open until Temporal's
    // activity budget expired, the activity was retried, and the retry sent the
    // message a second time.
    const sockets: import('node:net').Socket[] = [];
    const stalling = createServer((req) => {
      sockets.push(req.socket);
    });
    await new Promise<void>((resolve) => stalling.listen(0, '127.0.0.1', resolve));
    const stallingUrl = `http://127.0.0.1:${(stalling.address() as AddressInfo).port}`;
    const handler = createSendgridNodeHandler(credentials, {
      baseUrl: stallingUrl,
      timeoutMs: 150,
    });
    const result = await handler(
      request('sendgrid', { connectorId: 'sendgrid-main', to: 'a@b.test', from: 'c@d.test', text: 't' }),
    );
    expect(result.status).toBe(502);
    expect(result.message).toMatch(/abort|timeout|timed out/i);
    for (const socket of sockets) socket.destroy();
    stalling.close();
  });
});
