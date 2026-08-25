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
 * The MCP server's control-plane client, at its two failure modes. Both matter
 * more than they look: the caller is an AI tool that sees one line of text and
 * has to decide what to do next.
 */
import { describe, it, expect } from 'vitest';
import { MetisApiClient } from '../mcp-client.js';

const jsonOk = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('the MCP control-plane client', () => {
  it('names the URL and the fix when Metis is not running', async () => {
    // `fetch` throws the same bare "fetch failed" for a refused connection, a
    // wrong port and an unresolvable host, and names none of them. This is the
    // commonest failure there is (the tool started before Metis did).
    const client = new MetisApiClient({
      url: 'http://127.0.0.1:9',
      user: 'admin',
      secret: 's',
      fetchImpl: () => Promise.reject(new Error('fetch failed')),
    });
    await expect(client.call('GET', '/api/workflows')).rejects.toThrow(
      /cannot reach Metis at http:\/\/127\.0\.0\.1:9.*metis up/s,
    );
  });

  it('retries a 401 exactly once, rather than for ever', async () => {
    // A fresh token that is STILL refused (rotated signing key, clock skew, an
    // evicted session) used to recurse without limit. An MCP server that never
    // returns is worse than one that reports the 401: the tool just waits.
    let logins = 0;
    let calls = 0;
    const client = new MetisApiClient({
      url: 'http://metis.test',
      user: 'admin',
      secret: 's',
      fetchImpl: (input) => {
        const url = String(input);
        if (url.endsWith('/api/auth/login')) {
          logins += 1;
          return Promise.resolve(jsonOk({ token: 'a-token-the-server-will-not-accept' }));
        }
        calls += 1;
        return Promise.resolve(new Response('{"error":"unauthorised"}', { status: 401 }));
      },
    });

    await expect(client.call('GET', '/api/workflows')).rejects.toThrow(/401/);
    expect(logins).toBe(2);
    expect(calls).toBe(2);
  });

  it('still recovers from an ordinary expired token', async () => {
    let logins = 0;
    const client = new MetisApiClient({
      url: 'http://metis.test',
      user: 'admin',
      secret: 's',
      fetchImpl: (input) => {
        const url = String(input);
        if (url.endsWith('/api/auth/login')) {
          logins += 1;
          return Promise.resolve(jsonOk({ token: `token-${logins}` }));
        }
        // The first token is stale; the one issued after it works.
        return Promise.resolve(logins < 2 ? new Response('{}', { status: 401 }) : jsonOk([{ id: 'wf-1' }]));
      },
    });

    await expect(client.call('GET', '/api/workflows')).resolves.toEqual([{ id: 'wf-1' }]);
    expect(logins).toBe(2);
  });
});
