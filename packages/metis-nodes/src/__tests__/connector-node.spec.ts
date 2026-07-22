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
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeCredentialPort, nodeCtx, nodeOutput } from '@mindlynx/metis-ports';
import { DataGateway, MemoryAdapter } from '@mindlynx/metis-data-gateway';
import { ConnectorRegistry, registerConnectorTable } from '../connector-registry.js';
import { createConnectorNodeHandler } from '../connector-node.js';

// The node TYPE is the connector; config.connectorId is the chosen connection.
// In these tests the two ids coincide (e.g. 'crm'), so derive the type from it.
const request = (config: Record<string, unknown>) =>
  nodeCtx(String(config.connectorId ?? 'connector'), config);

describe('generic connector node', () => {
  let server: Server;
  let baseUrl: string;
  const seen: { url?: string; method?: string; auth?: string; custom?: string; body?: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        seen.push({
          url: req.url,
          method: req.method,
          auth: req.headers.authorization,
          custom: String(req.headers['x-api-key'] ?? ''),
          body: raw,
        });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ pong: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  const buildHandler = async () => {
    const gateway = new DataGateway(new MemoryAdapter());
    registerConnectorTable(gateway);
    const registry = new ConnectorRegistry(gateway);
    await registry.register('t1', {
      connectorId: 'crm',
      name: 'Local CRM',
      baseUrl,
      authScheme: 'bearer',
    });
    await registry.register('t1', {
      connectorId: 'metrics',
      name: 'Metrics service',
      baseUrl,
      authScheme: 'header',
      authHeaderName: 'x-api-key',
    });
    await registry.register('t1', {
      connectorId: 'crmOps',
      name: 'CRM with operations',
      baseUrl,
      authScheme: 'bearer',
      operations: [
        { name: 'getDeal', method: 'GET', pathTemplate: '/deals/{dealId}', wireStatus: 'verified' },
        { name: 'createDeal', method: 'POST', pathTemplate: '/deals', wireStatus: 'verified' },
        { name: 'notReady', method: 'GET', pathTemplate: '/soon', wireStatus: 'unverified' },
      ],
    });
    // An email connector whose sendEmail operation declares its typed inputs.
    await registry.register('t1', {
      connectorId: 'mailer',
      name: 'Mailer',
      baseUrl,
      authScheme: 'bearer',
      operations: [
        {
          name: 'sendEmail',
          method: 'POST',
          pathTemplate: '/emails',
          parameters: [
            { key: 'from', label: 'From', type: 'email', required: true },
            { key: 'to', label: 'To', type: 'email', required: true },
            { key: 'subject', label: 'Subject', required: true },
            { key: 'html', label: 'Body (HTML)', type: 'text' },
          ],
          wireStatus: 'verified',
        },
      ],
    });
    const credentials = new FakeCredentialPort(
      {},
      {
        't1/crm': { name: 'crm', connectorId: 'crm', material: { apiKey: 'crm-secret-token' } },
        't1/metrics': { name: 'metrics', connectorId: 'metrics', material: { apiKey: 'metrics-key-9' } },
        't1/crmOps': { name: 'crmOps', connectorId: 'crmOps', material: { apiKey: 'ops-token' } },
        't1/mailer': { name: 'mailer', connectorId: 'mailer', material: { apiKey: 'mail-token' } },
      },
    );
    return { handler: createConnectorNodeHandler(registry, credentials), registry };
  };

  it('runs a registered bearer connector with auth substituted at the credential boundary', async () => {
    const { handler } = await buildHandler();
    const result = await handler(
      request({ connectorId: 'crm', method: 'GET', path: '/contacts?limit=2' }),
    );
    expect(result.status).toBe(200);
    expect((nodeOutput(result) as { data: { pong: boolean } }).data.pong).toBe(true);
    const call = seen.at(-1);
    expect(call?.url).toBe('/contacts?limit=2');
    expect(call?.auth).toBe('Bearer crm-secret-token');
    expect(JSON.stringify(result)).not.toContain('crm-secret-token');
  });

  it('supports header-scheme connectors with a named header', async () => {
    const { handler } = await buildHandler();
    const result = await handler(request({ connectorId: 'metrics', method: 'GET', path: '/ping' }));
    expect(result.status).toBe(200);
    expect(seen.at(-1)?.custom).toBe('metrics-key-9');
  });

  it('fails cleanly for unregistered connectors', async () => {
    const { handler } = await buildHandler();
    const result = await handler(request({ connectorId: 'nowhere', method: 'GET', path: '/x' }));
    expect(result.status).not.toBe(200);
    expect(result.message).toMatch(/not registered/i);
  });

  it('refuses paths that would escape the connector base URL host', async () => {
    const { handler } = await buildHandler();
    const result = await handler(
      request({ connectorId: 'crm', method: 'GET', path: 'http://10.0.0.1/steal' }),
    );
    expect(result.status).not.toBe(200);
  });

  it('dispatches a named GET operation, interpolating a path token', async () => {
    const { handler } = await buildHandler();
    const result = await handler(
      request({ connectorId: 'crmOps', operation: 'getDeal', params: { dealId: 42 } }),
    );
    expect(result.status).toBe(200);
    const call = seen.at(-1);
    expect(call?.method).toBe('GET');
    expect(call?.url).toBe('/deals/42');
    expect(call?.auth).toBe('Bearer ops-token');
  });

  it('routes leftover GET params to the query string', async () => {
    const { handler } = await buildHandler();
    await handler(
      request({ connectorId: 'crmOps', operation: 'getDeal', params: { dealId: 7, expand: 'owner' } }),
    );
    expect(seen.at(-1)?.url).toBe('/deals/7?expand=owner');
  });

  it('routes leftover POST params to a JSON body', async () => {
    const { handler } = await buildHandler();
    const result = await handler(
      request({ connectorId: 'crmOps', operation: 'createDeal', params: { title: 'Acme', amount: 100 } }),
    );
    expect(result.status).toBe(200);
    const call = seen.at(-1);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('/deals');
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ title: 'Acme', amount: 100 });
  });

  it('delivers a sendEmail operation as the connector POST body (email node needs)', async () => {
    const { handler } = await buildHandler();
    const email = { from: 'you@d.com', to: 'a@b.com', subject: 'Hi', html: '<p>Hello</p>' };
    const result = await handler(request({ connectorId: 'mailer', operation: 'sendEmail', params: email }));
    expect(result.status).toBe(200);
    const call = seen.at(-1);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('/emails');
    expect(call?.auth).toBe('Bearer mail-token');
    expect(JSON.parse(call?.body ?? '{}')).toEqual(email);
  });

  it('fails when a required path token is missing', async () => {
    const { handler } = await buildHandler();
    const result = await handler(request({ connectorId: 'crmOps', operation: 'getDeal', params: {} }));
    expect(result.status).not.toBe(200);
    expect(result.message).toMatch(/missing required path parameter/i);
  });

  it('fails for an unknown operation name', async () => {
    const { handler } = await buildHandler();
    const result = await handler(request({ connectorId: 'crmOps', operation: 'nope', params: {} }));
    expect(result.status).not.toBe(200);
    expect(result.message).toMatch(/no operation "nope"/i);
  });

  it('refuses to run an unverified operation', async () => {
    const { handler } = await buildHandler();
    const result = await handler(request({ connectorId: 'crmOps', operation: 'notReady', params: {} }));
    expect(result.status).not.toBe(200);
    expect(result.nodeData?.code).toBe('unverified');
  });
});
