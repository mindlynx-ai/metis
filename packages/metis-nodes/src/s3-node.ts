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
 * The object-store node: put, get, list and presign against S3 or anything
 * that speaks it (MinIO, R2, B2), signed by hand because Metis ships no AWS
 * SDK. Credentials come from the connection at the CredentialPort boundary and
 * are never echoed; a presigned URL carries the key id, which is public, and
 * never the secret.
 *
 * THE SIZE RULE, which is most of the design. A node's output rides the
 * workflow state through Temporal's ~2 MB payload limit on EVERY later hop, so
 * bytes must not travel that way:
 *   - `get` hands back a REFERENCE by default: size, type, etag and a
 *     presigned URL. Zero bytes move, and the URL is what the next step, a
 *     person, or a browser opens.
 *   - text can be read inline up to the same 256 KB the data node uses,
 *     because a small JSON or CSV is genuinely more useful in the run than a
 *     link to it. Binary never inlines: base64 in workflow state is a third
 *     bigger, unreadable, and would blow the payload limit at the first hop.
 *   - `put` copies from a source URL through the activity, never through the
 *     state, capped at 25 MB. Above that the answer is a presigned PUT URL:
 *     the far side uploads to the bucket directly and Metis moves no bytes at
 *     all. Every ceiling refuses loudly; nothing is silently truncated.
 */
import {
  DEFAULT_MAX_BYTES,
  stateEnvelope,
  type CredentialPort,
  type NodeHandler,
  type NodeExecutionResult,
} from '@mindlynx/metis-ports';
import { checkUrlForSsrf, fetchFollowingGuardedRedirects } from './http-node.js';
import { presignUrl } from './sigv4.js';
import {
  checkEndpoint,
  objectUrl,
  parseListing,
  readCapped,
  resolveTarget,
  s3Error,
  s3Request,
  type S3Target,
} from './s3-client.js';

/** The most that may cross into workflow state (the data node's own ceiling). */
const MAX_INLINE_BYTES = DEFAULT_MAX_BYTES;
/** The most one step will copy through the activity. Bytes here never touch
 *  the workflow payload, but a worker slot held on a 2 GB video is its own
 *  outage, and presign is the unbounded path. */
const MAX_TRANSFER_BYTES = 25 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = 30_000;
const DEFAULT_EXPIRY_SECONDS = 900;
/** SigV4 refuses a longer presigned URL than this outright. */
const MAX_EXPIRY_SECONDS = 604_800;
const MAX_KEYS = 1000;

/** Content types that read as text in a run. Anything else is a reference. */
const TEXTUAL = /^(text\/|application\/(json|xml|x-ndjson|javascript|csv)|application\/[\w.+-]*\+(json|xml))/i;

export interface S3NodeConfig {
  /** The chosen connection instance id (material is resolved from this). */
  connectorId?: string;
  connectionId?: string;
  operation?: string;
  /** Overrides the connection's bucket, so one connection can serve several. */
  bucket?: string;
  key?: string;
  /** put: inline content, or a source URL to copy from. */
  body?: string;
  sourceUrl?: string;
  contentType?: string;
  /** get: 'reference' (default) or 'text'. */
  output?: string;
  /** list */
  prefix?: string;
  maxKeys?: number;
  continuationToken?: string;
  /** presign */
  expiresIn?: number;
  method?: string;
  /** The SSRF opt-in for a private source URL, as on the http node. */
  allowedHosts?: string[];
}

/** What an operation gives back: the step's output, or the failure verbatim.
 *  Wrapping the success shape once, in the handler, keeps the node id and type
 *  out of the operations and off any module-level state. */
type Outcome = { data: Record<string, unknown> } | NodeExecutionResult;

const fail = (status: number, message: string, code?: string): NodeExecutionResult => ({
  status,
  message,
  ...(code ? { nodeData: { code } } : {}),
});

const ok = (data: Record<string, unknown>): Outcome => ({ data });

const expiry = (config: S3NodeConfig): number =>
  Math.min(Number(config.expiresIn ?? DEFAULT_EXPIRY_SECONDS) || DEFAULT_EXPIRY_SECONDS, MAX_EXPIRY_SECONDS);

/** A presigned URL for one object: the reference every operation hands on. */
function signedUrlFor(target: S3Target, key: string, method: string, expiresIn: number): string {
  return presignUrl(
    { method, url: objectUrl(target, key), region: target.region, expiresIn },
    target.credentials,
  );
}

/** The bytes to store: inline content, or a copy of what a URL serves. */
async function bytesToPut(
  config: S3NodeConfig,
): Promise<{ body: Uint8Array; contentType: string } | { error: NodeExecutionResult }> {
  const sourceUrl = String(config.sourceUrl ?? '');
  if (sourceUrl === '') {
    const body = Buffer.from(String(config.body ?? ''), 'utf8');
    if (body.length > MAX_INLINE_BYTES) {
      return { error: fail(413, `the body is over the ${MAX_INLINE_BYTES} byte inline ceiling`, 'too-large') };
    }
    return { body, contentType: config.contentType ?? 'text/plain' };
  }
  const check = await checkUrlForSsrf(sourceUrl, config.allowedHosts);
  if (!check.allowed) return { error: fail(400, check.reason ?? 'ssrf_blocked') };
  // Every hop is re-checked, and the clock is the http node's own default: a
  // source that never answers would otherwise hold the activity open.
  const response = await fetchFollowingGuardedRedirects(
    sourceUrl,
    { method: 'GET' },
    config.allowedHosts,
    AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  );
  if (!response.ok) {
    return { error: fail(502, `the source URL answered ${response.status}`) };
  }
  try {
    return {
      body: await readCapped(response, MAX_TRANSFER_BYTES),
      contentType:
        config.contentType ?? response.headers.get('content-type') ?? 'application/octet-stream',
    };
  } catch (error) {
    return {
      error: fail(
        413,
        `${error instanceof Error ? error.message : String(error)}. Presign a PUT URL and let the far side upload directly.`,
        'too-large',
      ),
    };
  }
}

async function put(target: S3Target, config: S3NodeConfig, key: string): Promise<Outcome> {
  const source = await bytesToPut(config);
  if ('error' in source) return source.error;
  const response = await s3Request(target, {
    method: 'PUT',
    key,
    body: source.body,
    contentType: source.contentType,
  });
  if (!response.ok) return fail(502, await s3Error(response, `put "${key}"`));
  await response.arrayBuffer();
  return ok({
    bucket: target.bucket,
    key,
    size: source.body.length,
    contentType: source.contentType,
    etag: response.headers.get('etag')?.replace(/"/g, '') ?? undefined,
    location: objectUrl(target, key).toString(),
  });
}

/** A get that moves no bytes: HEAD for the metadata, plus a presigned URL. */
async function getReference(
  target: S3Target,
  config: S3NodeConfig,
  key: string,
): Promise<Outcome> {
  const response = await s3Request(target, { method: 'HEAD', key });
  if (!response.ok) return fail(502, await s3Error(response, `get "${key}"`));
  const expiresIn = expiry(config);
  return ok({
    bucket: target.bucket,
    key,
    size: Number(response.headers.get('content-length') ?? 0),
    contentType: response.headers.get('content-type') ?? undefined,
    etag: response.headers.get('etag')?.replace(/"/g, '') ?? undefined,
    lastModified: response.headers.get('last-modified') ?? undefined,
    url: signedUrlFor(target, key, 'GET', expiresIn),
    expiresIn,
    inline: false,
  });
}

async function getText(target: S3Target, key: string): Promise<Outcome> {
  const response = await s3Request(target, { method: 'GET', key });
  if (!response.ok) return fail(502, await s3Error(response, `get "${key}"`));
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType !== '' && !TEXTUAL.test(contentType)) {
    await response.body?.cancel();
    return fail(
      415,
      `"${key}" is ${contentType}, which cannot ride the workflow payload as text. Use the reference output.`,
      'not-text',
    );
  }
  try {
    const body = await readCapped(response, MAX_INLINE_BYTES);
    return ok({
      bucket: target.bucket,
      key,
      body: Buffer.from(body).toString('utf8'),
      size: body.length,
      contentType: contentType === '' ? undefined : contentType,
      inline: true,
    });
  } catch (error) {
    return fail(
      413,
      `${error instanceof Error ? error.message : String(error)}. Use the reference output for anything larger.`,
      'too-large',
    );
  }
}

async function list(target: S3Target, config: S3NodeConfig): Promise<Outcome> {
  const query: Record<string, string> = {
    'list-type': '2',
    'max-keys': String(Math.min(Number(config.maxKeys ?? MAX_KEYS) || MAX_KEYS, MAX_KEYS)),
  };
  if (config.prefix) query.prefix = String(config.prefix);
  if (config.continuationToken) query['continuation-token'] = String(config.continuationToken);
  const response = await s3Request(target, { method: 'GET', query });
  if (!response.ok) return fail(502, await s3Error(response, `list "${target.bucket}"`));
  const listing = parseListing(await response.text());
  return ok({ bucket: target.bucket, prefix: config.prefix ?? '', ...listing });
}

function presign(target: S3Target, config: S3NodeConfig, key: string): Outcome {
  const method = String(config.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'PUT') {
    return fail(400, `presign supports GET and PUT, not "${method}"`);
  }
  const expiresIn = expiry(config);
  return ok({
    bucket: target.bucket,
    key,
    method,
    url: signedUrlFor(target, key, method, expiresIn),
    expiresIn,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  });
}

function run(
  target: S3Target,
  config: S3NodeConfig,
  key: string,
  operation: string,
): Promise<Outcome> | Outcome {
  if (operation === 'put') return put(target, config, key);
  if (operation === 'get') {
    return config.output === 'text' ? getText(target, key) : getReference(target, config, key);
  }
  if (operation === 'list') return list(target, config);
  if (operation === 'presign') return presign(target, config, key);
  return fail(400, `unknown object store operation "${operation}"`);
}

export function createS3NodeHandler(credentials: CredentialPort): NodeHandler {
  return async (ctx) => {
    const config = ctx.nodeRef.config as S3NodeConfig;
    const operation = String(config.operation ?? 'put').toLowerCase();
    const connectionId = String(config.connectionId ?? config.connectorId ?? '');
    if (connectionId === '') return fail(400, 'the object store step needs a connection');
    const key = String(config.key ?? '').replace(/^\/+/, '');
    if (key === '' && operation !== 'list') {
      return fail(400, `the "${operation}" operation needs a key`);
    }

    let material: Record<string, string>;
    try {
      material = await credentials.resolveConnectorCredentials(ctx.tenantId, connectionId);
    } catch {
      return fail(500, `could not resolve credentials for connection "${connectionId}"`, 'credentials');
    }
    const target = resolveTarget(material, config.bucket);
    if ('error' in target) return fail(400, target.error);
    const blocked = await checkEndpoint(target, material);
    if (blocked) return fail(400, blocked);

    try {
      const outcome = await run(target, config, key, operation);
      return 'data' in outcome
        ? {
            status: 200,
            message: 'ok',
            nodeData: stateEnvelope(ctx.nodeRef.id, ctx.nodeRef.type, outcome.data),
          }
        : outcome;
    } catch (error) {
      return fail(502, error instanceof Error ? error.message : String(error));
    }
  };
}
