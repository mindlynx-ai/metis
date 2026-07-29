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
 * The object store node against a stub that speaks enough S3 to answer. The
 * cases worth pinning are the ones that would otherwise fail expensively: a
 * ceiling that truncates instead of refusing, a binary body inlined into
 * workflow state, an endpoint reaching a private address, and a secret in an
 * output. The signature itself is proven in sigv4.spec.ts and, live, against
 * MinIO in s3-real.spec.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeCredentialPort, nodeCtx, nodeOutput } from '@mindlynx/metis-ports';
import { createS3NodeHandler } from '../s3-node.js';

const SECRET = 'stub-secret-access-key';
const BUCKET = 'metis-sample';

interface Seen {
  method: string;
  url: string;
  authorization?: string;
  contentSha?: string;
  contentType?: string;
  body: string;
}

let server: Server;
let endpoint: string;
let seen: Seen[] = [];

/** The stub's canned objects, keyed by path. */
const OBJECTS: Record<string, { type: string; body: string }> = {
  [`/${BUCKET}/notes/order.json`]: { type: 'application/json', body: '{"order":42}' },
  [`/${BUCKET}/evidence/photo.jpg`]: { type: 'image/jpeg', body: 'not really a jpeg' },
  [`/${BUCKET}/big.txt`]: { type: 'text/plain', body: 'x'.repeat(300 * 1024) },
};

const LISTING = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Name>${BUCKET}</Name><IsTruncated>true</IsTruncated>
<NextContinuationToken>page-2</NextContinuationToken>
<Contents><Key>products/a &amp; b.png</Key><Size>1024</Size>
<LastModified>2026-07-01T09:00:00.000Z</LastModified><ETag>&quot;abc123&quot;</ETag></Contents>
<Contents><Key>products/c.png</Key><Size>2048</Size></Contents>
</ListBucketResult>`;

const noop = () => undefined;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => resolve(body));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    readBody(req).then((body) => {
      const url = req.url ?? '';
      seen.push({
        method: req.method ?? '',
        url,
        authorization: req.headers.authorization,
        contentSha: req.headers['x-amz-content-sha256'] as string | undefined,
        contentType: req.headers['content-type'],
        body,
      });
      // The source a "copy from URL" put reads, and its oversized twin: the
      // second lies about a 2 GB length, which is how a real one would.
      if (url === '/source/photo.jpg') {
        res.setHeader('content-type', 'image/jpeg');
        res.end('photo-bytes');
        return;
      }
      if (url === '/source/redirect') {
        // A source that bounces to a private address: the guard has to look at
        // the hop it lands on, not only the one it was given.
        res.statusCode = 302;
        res.setHeader('location', 'http://169.254.169.254/latest/meta-data/');
        res.end('');
        return;
      }
      if (url === '/source/huge.bin') {
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-length', String(2 * 1024 * 1024 * 1024));
        res.end('pretend');
        return;
      }
      if (url.startsWith(`/${BUCKET}/?`) || url === `/${BUCKET}/`) {
        res.setHeader('content-type', 'application/xml');
        res.end(LISTING);
        return;
      }
      const object = OBJECTS[url.split('?')[0]];
      if (req.method === 'PUT') {
        res.setHeader('etag', '"put-etag"');
        res.end('');
        return;
      }
      if (!object) {
        res.statusCode = 404;
        res.end('<Error><Code>NoSuchKey</Code><Message>key not found</Message></Error>');
        return;
      }
      res.setHeader('content-type', object.type);
      res.setHeader('content-length', String(Buffer.byteLength(object.body)));
      res.setHeader('etag', '"object-etag"');
      res.end(req.method === 'HEAD' ? undefined : object.body);
    }, noop);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

/** A connection whose endpoint is the stub. The loopback address is refused by
 *  the SSRF guard unless the connection names it, which is the opt-in. */
function connection(extra: Record<string, string> = {}): FakeCredentialPort {
  return new FakeCredentialPort(
    {},
    {
      't1/store': {
        name: 'store',
        connectorId: 's3',
        material: {
          accessKeyId: 'AKIDEXAMPLE',
          secretAccessKey: SECRET,
          region: 'eu-west-1',
          bucket: BUCKET,
          endpoint,
          allowPrivateEndpoint: 'true',
          ...extra,
        },
      },
    },
  );
}

const run = (config: Record<string, unknown>, credentials = connection()) =>
  createS3NodeHandler(credentials)(nodeCtx('s3', { connectorId: 'store', ...config }));

beforeAll(() => {
  seen = [];
});

describe('put', () => {
  it('stores inline content, signed, and gives back a reference not the bytes', async () => {
    seen = [];
    const result = await run({ operation: 'put', key: 'notes/order.json', body: '{"order":42}', contentType: 'application/json' });
    expect(result.status).toBe(200);
    expect(nodeOutput(result)).toMatchObject({
      bucket: BUCKET,
      key: 'notes/order.json',
      size: 12,
      contentType: 'application/json',
      etag: 'put-etag',
    });
    const put = seen.find((r) => r.method === 'PUT');
    expect(put?.url).toBe(`/${BUCKET}/notes/order.json`);
    expect(put?.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/s3\/aws4_request/);
    // The body hash is signed, so a proxy cannot alter the bytes in flight.
    expect(put?.contentSha).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('escapes a key with a space rather than sending two paths', async () => {
    seen = [];
    await run({ operation: 'put', key: 'evidence/ord 42/photo (1).jpg', body: 'x' });
    expect(seen.find((r) => r.method === 'PUT')?.url).toBe(
      `/${BUCKET}/evidence/ord%2042/photo%20%281%29.jpg`,
    );
  });

  it('copies from a source URL, and never through the workflow payload', async () => {
    seen = [];
    const result = await run({
      operation: 'put',
      key: 'evidence/photo.jpg',
      sourceUrl: `${endpoint}/source/photo.jpg`,
      allowedHosts: ['127.0.0.1'],
    });
    expect(result.status).toBe(200);
    // The content type follows the source, so the object is served correctly.
    expect(nodeOutput(result)).toMatchObject({ size: 11, contentType: 'image/jpeg' });
    expect(JSON.stringify(nodeOutput(result))).not.toContain('photo-bytes');
  });

  it('refuses an inline body over the payload ceiling instead of truncating it', async () => {
    const result = await run({ operation: 'put', key: 'big.txt', body: 'x'.repeat(300 * 1024) });
    expect(result.status).toBe(413);
    expect(result.message).toMatch(/inline ceiling/);
  });

  it('refuses an oversized source and names the way round it', async () => {
    const result = await run({
      operation: 'put',
      key: 'huge.bin',
      sourceUrl: `${endpoint}/source/huge.bin`,
      allowedHosts: ['127.0.0.1'],
    });
    expect(result.status).toBe(413);
    expect(result.message).toMatch(/ceiling/);
    expect(result.message).toMatch(/[Pp]resign/);
  });

  it('refuses a redirect off the named host, which is how a guard gets walked past', async () => {
    const result = await run({
      operation: 'put',
      key: 'x',
      sourceUrl: `${endpoint}/source/redirect`,
      allowedHosts: ['127.0.0.1'],
    });
    expect(result.status).toBe(502);
    expect(result.message).toMatch(/ssrf_blocked redirect/);
  });

  it('refuses a source URL on a private address that was not named', async () => {
    const result = await run({ operation: 'put', key: 'x', sourceUrl: `${endpoint}/source/photo.jpg` });
    expect(result.status).toBe(400);
    expect(result.message).toMatch(/ssrf_blocked/);
  });
});

describe('get', () => {
  it('hands back a reference by default: metadata and a link, no bytes', async () => {
    seen = [];
    const result = await run({ operation: 'get', key: 'evidence/photo.jpg' });
    const output = nodeOutput(result) as { url: string; inline: boolean; size: number };
    expect(output.inline).toBe(false);
    expect(output.size).toBe(17);
    expect(output.url).toContain('X-Amz-Signature=');
    expect(output.url).toContain('X-Amz-Expires=900');
    // HEAD, so not one byte of the object moved.
    expect(seen.map((r) => r.method)).toContain('HEAD');
    expect(seen.every((r) => r.body === '')).toBe(true);
  });

  it('reads small text inline when asked, because a link to 12 bytes is useless', async () => {
    const result = await run({ operation: 'get', key: 'notes/order.json', output: 'text' });
    expect(nodeOutput(result)).toMatchObject({ body: '{"order":42}', inline: true, size: 12 });
  });

  it('refuses to inline binary, whatever the size', async () => {
    const result = await run({ operation: 'get', key: 'evidence/photo.jpg', output: 'text' });
    expect(result.status).toBe(415);
    expect(result.message).toMatch(/reference output/);
  });

  it('refuses text over the ceiling rather than handing back half a file', async () => {
    const result = await run({ operation: 'get', key: 'big.txt', output: 'text' });
    expect(result.status).toBe(413);
    expect(result.message).toMatch(/reference output/);
  });

  it('reports what S3 said when the key is not there', async () => {
    const result = await run({ operation: 'get', key: 'nope', output: 'text' });
    expect(result.status).toBe(502);
    expect(result.message).toMatch(/NoSuchKey/);
  });
});

describe('list', () => {
  it('reads the keys, the page marker and an escaped key correctly', async () => {
    seen = [];
    const result = await run({ operation: 'list', prefix: 'products/', maxKeys: 2 });
    expect(nodeOutput(result)).toMatchObject({
      bucket: BUCKET,
      prefix: 'products/',
      count: 2,
      truncated: true,
      nextToken: 'page-2',
    });
    const output = nodeOutput(result) as { objects: { key: string; size: number; etag?: string }[] };
    expect(output.objects[0]).toMatchObject({ key: 'products/a & b.png', size: 1024, etag: 'abc123' });
    const list = seen.find((r) => r.method === 'GET');
    expect(list?.url).toContain('list-type=2');
    expect(list?.url).toContain('max-keys=2');
  });

  it('needs no key, unlike every other operation', async () => {
    expect((await run({ operation: 'get' })).status).toBe(400);
    expect((await run({ operation: 'list' })).status).toBe(200);
  });
});

describe('presign', () => {
  it('mints a download link that expires', async () => {
    const result = await run({ operation: 'presign', key: 'evidence/photo.jpg', expiresIn: 60 });
    const output = nodeOutput(result) as { url: string; method: string; expiresIn: number; expiresAt: string };
    expect(output.method).toBe('GET');
    expect(output.expiresIn).toBe(60);
    expect(output.url).toContain('X-Amz-Expires=60');
    expect(Date.parse(output.expiresAt)).toBeGreaterThan(Date.now());
    expect(output.url).not.toContain(SECRET);
  });

  it('mints an upload slot, which is how a file too big for a step gets in', async () => {
    const result = await run({ operation: 'presign', key: 'evidence/video.mp4', method: 'PUT' });
    expect((nodeOutput(result) as { url: string }).url).toContain('X-Amz-Credential=');
    expect((nodeOutput(result) as { method: string }).method).toBe('PUT');
  });

  it('caps the expiry at the week SigV4 itself allows', async () => {
    const result = await run({ operation: 'presign', key: 'k', expiresIn: 60 * 60 * 24 * 30 });
    expect((nodeOutput(result) as { expiresIn: number }).expiresIn).toBe(604_800);
  });

  it('refuses a method it cannot sign for', async () => {
    const result = await run({ operation: 'presign', key: 'k', method: 'DELETE' });
    expect(result.status).toBe(400);
  });
});

describe('the guards around a connection', () => {
  it('refuses a private endpoint the connection did not name', async () => {
    const credentials = new FakeCredentialPort(
      {},
      {
        't1/store': {
          name: 'store',
          connectorId: 's3',
          material: { accessKeyId: 'k', secretAccessKey: SECRET, region: 'eu-west-1', bucket: BUCKET, endpoint },
        },
      },
    );
    const result = await run({ operation: 'list' }, credentials);
    expect(result.status).toBe(400);
    expect(result.message).toMatch(/allowPrivateEndpoint/);
  });

  it('says which connection could not be resolved, and never why', async () => {
    const result = await createS3NodeHandler(new FakeCredentialPort())(
      nodeCtx('s3', { connectorId: 'missing', operation: 'list' }),
    );
    expect(result.status).toBe(500);
    expect(result.nodeData).toMatchObject({ code: 'credentials' });
  });

  it('needs a connection at all', async () => {
    const result = await createS3NodeHandler(connection())(nodeCtx('s3', { operation: 'list' }));
    expect(result.status).toBe(400);
    expect(result.message).toMatch(/needs a connection/);
  });

  it('refuses a connection with no bucket rather than guessing one', async () => {
    const result = await run({ operation: 'list' }, connection({ bucket: '' }));
    expect(result.status).toBe(400);
    expect(result.message).toMatch(/no bucket/);
  });

  it('lets a step name another bucket on the same connection', async () => {
    seen = [];
    await run({ operation: 'put', key: 'k', body: 'v', bucket: 'other-bucket' });
    expect(seen.find((r) => r.method === 'PUT')?.url).toBe('/other-bucket/k');
  });

  it('refuses an operation it does not have', async () => {
    const result = await run({ operation: 'delete', key: 'k' });
    expect(result.status).toBe(400);
    expect(result.message).toMatch(/unknown object store operation/);
  });
});
