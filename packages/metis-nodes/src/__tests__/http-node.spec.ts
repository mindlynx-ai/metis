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
import { createHttpNodeHandler } from '../http-node.js';
import { nodeCtx, nodeOutput } from '@mindlynx/metis-ports';

const handler = createHttpNodeHandler();

const request = (config: Record<string, unknown>) => nodeCtx('api', config);

describe('http/api node', () => {
  let server: Server;
  let baseUrl: string;
  let failOnce = true;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        if (req.url === '/echo') {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              method: req.method,
              received: body ? JSON.parse(body) : null,
              header: req.headers['x-probe'],
            }),
          );
          return;
        }
        if (req.url === '/raw') {
          // Echoes the raw request body verbatim (no JSON.parse), so a
          // plain text/raw body can be asserted byte-for-byte.
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ method: req.method, raw: body }));
          return;
        }
        if (req.url === '/flaky') {
          if (failOnce) {
            failOnce = false;
            req.socket.destroy();
            return;
          }
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.url === '/slow') {
          return;
        }
        if (req.url === '/status-teapot') {
          res.statusCode = 418;
          res.end(JSON.stringify({ short: 'stout' }));
          return;
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('executes a POST against an allowlisted local stub with both header formats', async () => {
    const result = await handler(
      request({
        method: 'POST',
        url: `${baseUrl}/echo`,
        allowedHosts: ['127.0.0.1'],
        headers: [{ key: 'x-probe', value: 'array-format', enabled: true }],
        body: { type: 'json', content: { hello: 'metis' } },
      }),
    );
    expect(result.status).toBe(200);
    const output = nodeOutput(result) as { status: number; data: Record<string, unknown> };
    expect(output.status).toBe(200);
    expect(output.data.method).toBe('POST');
    expect(output.data.received).toEqual({ hello: 'metis' });
    expect(output.data.header).toBe('array-format');

    const legacy = await handler(
      request({
        method: 'POST',
        url: `${baseUrl}/echo`,
        allowedHosts: ['127.0.0.1'],
        headers: { 'x-probe': 'legacy-format' },
        body: { plain: true },
      }),
    );
    expect((nodeOutput(legacy) as { data: Record<string, unknown> }).data.header).toBe('legacy-format');
  });

  it('unwraps the {type, content} body envelope for json / text / raw', async () => {
    // json: the content object is unwrapped and JSON-serialised as the body.
    const jsonResult = await handler(
      request({
        method: 'POST',
        url: `${baseUrl}/echo`,
        allowedHosts: ['127.0.0.1'],
        body: { type: 'json', content: { hello: 'metis' } },
      }),
    );
    expect((nodeOutput(jsonResult) as { data: Record<string, unknown> }).data.received).toEqual({
      hello: 'metis',
    });

    // text: the string content passes through unchanged.
    const textResult = await handler(
      request({
        method: 'POST',
        url: `${baseUrl}/raw`,
        allowedHosts: ['127.0.0.1'],
        body: { type: 'text', content: 'hello' },
      }),
    );
    expect((nodeOutput(textResult) as { data: Record<string, unknown> }).data.raw).toBe('hello');

    // raw: the string content passes through unchanged.
    const rawResult = await handler(
      request({
        method: 'POST',
        url: `${baseUrl}/raw`,
        allowedHosts: ['127.0.0.1'],
        body: { type: 'raw', content: 'raw-bytes' },
      }),
    );
    expect((nodeOutput(rawResult) as { data: Record<string, unknown> }).data.raw).toBe('raw-bytes');

    // no body (GET): the request carries no body.
    const getResult = await handler(
      request({ method: 'GET', url: `${baseUrl}/echo`, allowedHosts: ['127.0.0.1'] }),
    );
    const getData = (nodeOutput(getResult) as { data: Record<string, unknown> }).data;
    expect(getData.method).toBe('GET');
    expect(getData.received).toBeNull();
  });

  it('handles PUT and DELETE methods', async () => {
    const put = await handler(
      request({
        method: 'PUT',
        url: `${baseUrl}/echo`,
        allowedHosts: ['127.0.0.1'],
        body: { type: 'json', content: { patched: true } },
      }),
    );
    const putData = (nodeOutput(put) as { data: Record<string, unknown> }).data;
    expect(putData.method).toBe('PUT');
    expect(putData.received).toEqual({ patched: true });

    const del = await handler(
      request({ method: 'DELETE', url: `${baseUrl}/echo`, allowedHosts: ['127.0.0.1'] }),
    );
    expect((nodeOutput(del) as { data: Record<string, unknown> }).data.method).toBe('DELETE');
  });

  it('does NOT unwrap a form body envelope (known schema/handler gap)', async () => {
    // note: the node schema lists a `form` body type, but unwrapBody only
    // unwraps json/raw/text, so the whole { type, content } envelope passes
    // through and is JSON-serialised as-is. Asserting the actual behaviour.
    const result = await handler(
      request({
        method: 'POST',
        url: `${baseUrl}/echo`,
        allowedHosts: ['127.0.0.1'],
        body: { type: 'form', content: { field: 'value' } },
      }),
    );
    expect((nodeOutput(result) as { data: Record<string, unknown> }).data.received).toEqual({
      type: 'form',
      content: { field: 'value' },
    });
  });

  it('completes with the response status for non-2xx responses', async () => {
    const result = await handler(
      request({ method: 'GET', url: `${baseUrl}/status-teapot`, allowedHosts: ['127.0.0.1'] }),
    );
    expect(result.status).toBe(200);
    const output = nodeOutput(result) as { status: number; ok: boolean };
    expect(output.status).toBe(418);
    expect(output.ok).toBe(false);
  });

  it('refuses loopback and private ranges without an explicit allowlist', async () => {
    for (const url of [
      `${baseUrl}/echo`,
      'http://10.0.0.1/internal',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:9999/x',
    ]) {
      const result = await handler(request({ method: 'GET', url }));
      expect(result.status).not.toBe(200);
      expect(result.message).toMatch(/blocked|ssrf/i);
    }
  });

  it('rejects unsupported schemes and unparseable urls', async () => {
    for (const url of ['ftp://example.test/file', 'not-a-url']) {
      const result = await handler(request({ method: 'GET', url }));
      expect(result.status).not.toBe(200);
    }
  });

  it('times out via the configured timeout', async () => {
    const result = await handler(
      request({ method: 'GET', url: `${baseUrl}/slow`, allowedHosts: ['127.0.0.1'], timeout: 200 }),
    );
    expect(result.status).not.toBe(200);
    expect(result.message).toMatch(/abort|timeout/i);
  });

  it('retries transport failures when configured', async () => {
    failOnce = true;
    const result = await handler(
      request({
        method: 'GET',
        url: `${baseUrl}/flaky`,
        allowedHosts: ['127.0.0.1'],
        retries: 1,
        retryDelay: 10,
      }),
    );
    expect(result.status).toBe(200);
    expect((nodeOutput(result) as { data: { ok: boolean } }).data.ok).toBe(true);
  });
});
