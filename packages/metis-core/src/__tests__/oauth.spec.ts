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
 * The OAuth2 authorization-code flow against a mock provider: start returns the
 * authorize URL with state; the callback exchanges the code at a real token
 * stub and stores the tokens as a connection. Proves the whole flow without a
 * real provider (real providers need the operator's registered OAuth app).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { SingleTenantIdentity, FakeCredentialPort } from '@mindlynx/metis-ports';
import { buildCoreServer } from '../server.js';
import type { OAuthConfig } from '../oauth.js';

describe('OAuth2 connector connections', () => {
  let tokenServer: Server;
  let app: FastifyInstance;
  const credentials = new FakeCredentialPort();
  let token: string;
  let lastTokenRequest: string | undefined;

  beforeAll(async () => {
    // A real token endpoint the callback will POST the code to.
    tokenServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        lastTokenRequest = body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ access_token: 'mock_access', refresh_token: 'mock_refresh', expires_in: 3600 }),
        );
      });
    });
    await new Promise<void>((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
    const tokenBase = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}`;

    const oauth: OAuthConfig = {
      providers: {
        mockconn: {
          authorizeUrl: 'https://provider.example/authorize',
          tokenUrl: `${tokenBase}/token`,
          scopes: ['read'],
        },
      },
      clientFor: () => ({ clientId: 'cid', clientSecret: 'csec' }),
      redirectBase: 'http://localhost:4180',
    };

    const identity = await SingleTenantIdentity.create('t1', [
      { userId: 'jeremy', secret: 'pw', role: 'admin' },
    ]);
    app = buildCoreServer({ identity, credentials, oauth });
    await app.ready();
    token = (
      (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: 'jeremy', secret: 'pw' } })).json() as {
        token: string;
      }
    ).token;
  });

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
  });

  const authed = (method: 'GET', url: string) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });

  it('reports the OAuth-capable connectors', async () => {
    expect((await authed('GET', '/api/connectors/oauth-capable')).json()).toEqual({
      connectors: ['mockconn'],
    });
  });

  it('runs start -> callback -> token exchange -> stored connection', async () => {
    const start = await authed('GET', '/api/connectors/mockconn/oauth/start');
    expect(start.statusCode).toBe(200);
    const authorizeUrl = new URL((start.json() as { authorizeUrl: string }).authorizeUrl);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://provider.example/authorize');
    expect(authorizeUrl.searchParams.get('client_id')).toBe('cid');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('http://localhost:4180/api/oauth/callback');
    const state = authorizeUrl.searchParams.get('state')!;
    expect(state).toBeTruthy();

    // The provider redirects the browser back to our public callback.
    const callback = await app.inject({
      method: 'GET',
      url: `/api/oauth/callback?code=auth_code_123&state=${encodeURIComponent(state)}`,
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain('/connectors?oauth=connected');

    // The token endpoint got the code + client secret; the tokens are stored as
    // a named connection for the connector type.
    expect(lastTokenRequest).toContain('code=auth_code_123');
    expect(lastTokenRequest).toContain('client_secret=csec');
    const list = (await authed('GET', '/api/connections')).json() as {
      connections: { connectionId: string; connectorId: string }[];
    };
    expect(list.connections).toHaveLength(1);
    expect(list.connections[0].connectorId).toBe('mockconn');
    expect(
      await credentials.resolveConnectorCredentials('t1', list.connections[0].connectionId),
    ).toMatchObject({ accessToken: 'mock_access', refreshToken: 'mock_refresh' });
  });

  it('rejects a bad/expired state at the callback', async () => {
    const bad = await app.inject({ method: 'GET', url: '/api/oauth/callback?code=x&state=forged' });
    expect(bad.statusCode).toBe(302);
    expect(bad.headers.location).toContain('oauth=badstate');
  });
});
