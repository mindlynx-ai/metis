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
 * The S3 node against a REAL object store, which is the only test that can
 * fail for the right reason. A stub answers whatever it is told to; MinIO
 * verifies the signature, so a canonical request with a stray byte in it is
 * rejected here and nowhere else. It is also the proof that "S3-compatible"
 * is a fact rather than a claim: nothing in the node knows it is not Amazon.
 *
 * Bring it up with the sample stack, then run with S3_REAL_TEST=1:
 *   docker compose -f compose/docker-compose.yml \
 *                  -f compose/docker-compose.sample-db.yml up -d minio minio-create-bucket
 * Skipped by name otherwise, never silently.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeCredentialPort, nodeCtx, nodeOutput } from '@mindlynx/metis-ports';
import { createS3NodeHandler } from '../s3-node.js';

const ENDPOINT = process.env.METIS_S3_ENDPOINT ?? 'http://127.0.0.1:9000';
const BUCKET = process.env.METIS_S3_BUCKET ?? 'metis-sample';
const MATERIAL = {
  accessKeyId: process.env.METIS_S3_ACCESS_KEY_ID ?? 'metis',
  // The sample compose file publishes this in the open, next to the database
  // passwords; it reaches a throwaway container and nothing else.
  secretAccessKey: process.env.METIS_S3_SECRET_ACCESS_KEY ?? 'metis-sample-secret',
  region: process.env.METIS_S3_REGION ?? 'us-east-1',
  bucket: BUCKET,
  endpoint: ENDPOINT,
  pathStyle: 'true',
  allowPrivateEndpoint: 'true',
};

const credentials = (material = MATERIAL) =>
  new FakeCredentialPort({}, { 't1/store': { name: 'store', connectorId: 's3', material } });

const run = (config: Record<string, unknown>, material = MATERIAL) =>
  createS3NodeHandler(credentials(material))(nodeCtx('s3', { connectorId: 'store', ...config }));

const suite = process.env.S3_REAL_TEST === '1' ? describe : describe.skip;
const prefix = `run-${Date.now()}`;

suite('the S3 node against MinIO', () => {
  let source: Server;
  let sourceUrl: string;

  beforeAll(async () => {
    // Something for "copy from URL" to copy, standing in for the photo a
    // webhook hands a return workflow.
    source = createServer((_req, res) => {
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.from('89504e470d0a1a0a-pretend-png', 'utf8'));
    });
    await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
    sourceUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}/photo.png`;
  });

  afterAll(() => {
    source.close();
  });

  it('puts an object and reads it back byte for byte', async () => {
    const key = `${prefix}/notes/order.json`;
    const put = await run({ operation: 'put', key, body: '{"order":42}', contentType: 'application/json' });
    expect(put.status).toBe(200);
    expect(nodeOutput(put)).toMatchObject({ bucket: BUCKET, key, size: 12 });
    // MinIO returns the md5 of the body as the etag for a single-part put.
    expect((nodeOutput(put) as { etag: string }).etag).toMatch(/^[a-f0-9]{32}$/);

    const got = await run({ operation: 'get', key, output: 'text' });
    expect(got.status).toBe(200);
    expect(nodeOutput(got)).toMatchObject({ body: '{"order":42}', contentType: 'application/json' });
  });

  it('round-trips a key with a space and an ampersand in it', async () => {
    // The encoding cases that fail only against a real server: it re-signs
    // the path it received, so a key encoded one way and signed another is a
    // 403 here and a pass anywhere else.
    const key = `${prefix}/products/a & b (final).txt`;
    expect((await run({ operation: 'put', key, body: 'ok' })).status).toBe(200);
    const got = await run({ operation: 'get', key, output: 'text' });
    expect(nodeOutput(got)).toMatchObject({ body: 'ok', key });
  });

  it('copies a file straight from a URL into the bucket', async () => {
    const key = `${prefix}/evidence/photo.png`;
    const put = await run({ operation: 'put', key, sourceUrl, allowedHosts: ['127.0.0.1'] });
    expect(put.status).toBe(200);
    expect(nodeOutput(put)).toMatchObject({ contentType: 'image/png', size: 28 });

    // A binary object comes back as a reference: the metadata plus a link.
    const reference = await run({ operation: 'get', key });
    expect(nodeOutput(reference)).toMatchObject({ size: 28, contentType: 'image/png', inline: false });
  });

  it('lists what it wrote, under the prefix and nothing else', async () => {
    const listing = nodeOutput(await run({ operation: 'list', prefix: `${prefix}/` })) as {
      objects: { key: string; size: number }[];
      count: number;
      truncated: boolean;
    };
    expect(listing.truncated).toBe(false);
    expect(listing.objects.map((o) => o.key).sort()).toEqual([
      `${prefix}/evidence/photo.png`,
      `${prefix}/notes/order.json`,
      `${prefix}/products/a & b (final).txt`,
    ]);
    expect(listing.objects.find((o) => o.key.endsWith('order.json'))?.size).toBe(12);
  });

  it('pages a listing, and the next page starts where the first stopped', async () => {
    const first = nodeOutput(await run({ operation: 'list', prefix: `${prefix}/`, maxKeys: 1 })) as {
      objects: { key: string }[];
      truncated: boolean;
      nextToken: string;
    };
    expect(first.truncated).toBe(true);
    expect(first.nextToken).toBeTruthy();
    const second = nodeOutput(
      await run({ operation: 'list', prefix: `${prefix}/`, maxKeys: 1, continuationToken: first.nextToken }),
    ) as { objects: { key: string }[] };
    expect(second.objects[0].key).not.toBe(first.objects[0].key);
  });

  it('mints a download link a stranger can open with no credentials at all', async () => {
    const key = `${prefix}/notes/order.json`;
    const { url } = nodeOutput(await run({ operation: 'presign', key, expiresIn: 120 })) as { url: string };
    // No headers, no keys: everything that authorises this is in the URL, and
    // MinIO checks it. This is the proof that the presign signature is right.
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"order":42}');
  });

  it('mints an upload slot, which is how a file too big for a step gets in', async () => {
    const key = `${prefix}/uploads/direct.txt`;
    const { url } = nodeOutput(
      await run({ operation: 'presign', key, method: 'PUT', expiresIn: 120 }),
    ) as { url: string };
    const upload = await fetch(url, { method: 'PUT', body: 'uploaded by the far side' });
    expect(upload.status).toBe(200);

    const got = await run({ operation: 'get', key, output: 'text' });
    expect(nodeOutput(got)).toMatchObject({ body: 'uploaded by the far side' });
  });

  it('is actually checked: a wrong secret is refused, so a pass means something', async () => {
    const result = await run(
      { operation: 'list' },
      { ...MATERIAL, secretAccessKey: 'not-the-secret' },
    );
    expect(result.status).toBe(502);
    expect(result.message).toMatch(/SignatureDoesNotMatch/);
  });

  it('says which key is missing rather than failing blank', async () => {
    const result = await run({ operation: 'get', key: `${prefix}/nope` });
    expect(result.status).toBe(502);
    expect(result.message).toMatch(/404/);
  });
});
