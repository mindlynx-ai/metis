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
 * The S3 REST wire: where a bucket lives, how a request reaches it, and how to
 * read the two XML documents S3 answers with (a listing, and an error). The
 * signing itself is in sigv4.ts; this file is the part that differs between
 * AWS and the S3-compatible stores, which is exactly why it is separate.
 */
import { checkUrlForSsrf } from './http-node.js';
import {
  EMPTY_PAYLOAD_SHA256,
  canonicalUrl,
  encodeKeyPath,
  sha256Hex,
  signRequest,
  type SigV4Credentials,
} from './sigv4.js';

export interface S3Target {
  region: string;
  bucket: string;
  /** The service endpoint origin, e.g. https://s3.eu-west-1.amazonaws.com. */
  endpoint: string;
  /** Bucket in the path rather than the hostname. MinIO and a plain-IP
   *  endpoint have no wildcard DNS, so a virtual-hosted URL cannot resolve. */
  pathStyle: boolean;
  credentials: SigV4Credentials;
}

export interface S3TargetProblem {
  error: string;
}

const AWS_ENDPOINT = (region: string) => `https://s3.${region}.amazonaws.com`;

/** Trim trailing slashes without a regex: `/\/+$/` backtracks on a long run. */
function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

/**
 * Read a connection's material into a target. Nothing here is logged or
 * echoed: the secret goes into the credentials object and comes out only as a
 * signature.
 */
export function resolveTarget(
  material: Record<string, string>,
  bucketOverride?: string,
): S3Target | S3TargetProblem {
  const accessKeyId = material.accessKeyId?.trim() ?? '';
  const secretAccessKey = material.secretAccessKey ?? '';
  const region = material.region?.trim() || 'us-east-1';
  const bucket = (bucketOverride?.trim() || material.bucket?.trim()) ?? '';
  if (!accessKeyId || !secretAccessKey) {
    return { error: 'the connection has no accessKeyId / secretAccessKey' };
  }
  if (!bucket) return { error: 'the connection has no bucket, and the step names none' };
  const endpoint = material.endpoint?.trim() ?? '';
  return {
    region,
    bucket,
    endpoint: endpoint === '' ? AWS_ENDPOINT(region) : trimTrailingSlash(endpoint),
    // A custom endpoint defaults to path style, because that is what the
    // S3-compatible stores serve; `pathStyle: false` opts back out.
    pathStyle: material.pathStyle ? material.pathStyle === 'true' : endpoint !== '',
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken: material.sessionToken || undefined,
    },
  };
}

/** The URL of one object (or of the bucket itself, when the key is empty). */
export function objectUrl(target: S3Target, key: string, query: Record<string, string> = {}): URL {
  const base = new URL(target.endpoint);
  const path = key === '' ? '' : encodeKeyPath(key);
  const url = target.pathStyle
    ? new URL(`${base.origin}/${target.bucket}/${path}`)
    : new URL(`${base.protocol}//${target.bucket}.${base.host}/${path}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url;
}

/**
 * The endpoint goes through the http node's SSRF guard. It reaches here from a
 * stored connection rather than from workflow config, but "an admin typed it"
 * is not a security property: a connection pointed at 169.254.169.254 would
 * otherwise turn a workflow step into a cloud metadata reader. A private
 * endpoint (MinIO on the compose network, a dev box) is legitimate and stays
 * possible, but it has to be named: allowPrivateEndpoint on the connection,
 * which only somebody who can edit credentials can set.
 */
export async function checkEndpoint(
  target: S3Target,
  material: Record<string, string>,
): Promise<string | undefined> {
  const host = new URL(target.endpoint).hostname;
  const allowed = material.allowPrivateEndpoint === 'true' ? [host] : undefined;
  const check = await checkUrlForSsrf(target.endpoint, allowed);
  return check.allowed
    ? undefined
    : `${check.reason ?? 'ssrf_blocked'} (set allowPrivateEndpoint on the connection to allow it)`;
}

export interface S3RequestOptions {
  method: string;
  key?: string;
  query?: Record<string, string>;
  body?: Uint8Array;
  contentType?: string;
  /** Fixed in tests so a signed request is reproducible. */
  date?: Date;
  /** Overrides S3_TIMEOUT_MS, for a caller that knows its object is slower. */
  timeoutMs?: number;
}

/**
 * Ceiling on one S3 request, body included, because the signal covers the
 * stream and not just the connect.
 *
 * Chosen to sit UNDER the engine's two-minute activity budget: a request that
 * outlived that was going to be killed by Temporal anyway, and being killed
 * there means the activity is retried and the PUT happens again, while failing
 * here is one clean error the run can show. Generous for what the node moves:
 * it caps a transfer at 25 MB and a listing at 1000 keys.
 */
const S3_TIMEOUT_MS = 90_000;

/** Sign and send one S3 request. The response is returned unread: a caller
 *  that wants bytes decides its own ceiling before it takes any. */
export async function s3Request(target: S3Target, options: S3RequestOptions): Promise<Response> {
  const url = objectUrl(target, options.key ?? '', options.query ?? {});
  const payloadHash = options.body ? sha256Hex(options.body) : EMPTY_PAYLOAD_SHA256;
  const headers = signRequest(
    {
      method: options.method,
      url,
      headers: options.contentType ? { 'content-type': options.contentType } : {},
      payloadHash,
      region: target.region,
      date: options.date,
    },
    target.credentials,
  );
  // fetch owns the host header and rejects an explicit one; it sets the same
  // value from the URL, which is the value that was signed.
  delete headers.host;
  return fetch(canonicalUrl(url), {
    method: options.method,
    headers,
    body: options.body ? Buffer.from(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? S3_TIMEOUT_MS),
  });
}

const decodeXml = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

function tagValue(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeXml(match[1]) : undefined;
}

export interface S3Object {
  key: string;
  size: number;
  lastModified?: string;
  etag?: string;
}

export interface S3Listing {
  objects: S3Object[];
  count: number;
  truncated: boolean;
  nextToken?: string;
}

/** Parse a ListObjectsV2 response. S3 answers XML and always will, so the
 *  fields that matter are lifted out rather than a parser being added. */
export function parseListing(xml: string): S3Listing {
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((match) => ({
    key: tagValue(match[1], 'Key') ?? '',
    size: Number(tagValue(match[1], 'Size') ?? 0),
    lastModified: tagValue(match[1], 'LastModified'),
    etag: tagValue(match[1], 'ETag')?.replace(/"/g, ''),
  }));
  return {
    objects,
    count: objects.length,
    truncated: tagValue(xml, 'IsTruncated') === 'true',
    nextToken: tagValue(xml, 'NextContinuationToken'),
  };
}

/**
 * A failed request as one legible line. S3's error document carries the reason
 * (NoSuchBucket, SignatureDoesNotMatch, AccessDenied), and losing it to a bare
 * status code is what turns a five-second fix into an afternoon.
 */
export async function s3Error(response: Response, action: string): Promise<string> {
  const body = await response.text().catch(() => '');
  const code = tagValue(body, 'Code');
  const message = tagValue(body, 'Message');
  const detail = code ? `${code}: ${message ?? ''}`.trim() : body.slice(0, 200).trim();
  const reason = detail === '' ? '' : `: ${detail}`;
  return `${action} failed (${response.status})${reason}`;
}

/**
 * Read a response body, refusing past `max`. Content-Length is checked first so
 * an oversized object costs nothing to reject, and the stream is counted as
 * well because a wrong or absent length is the far side's choice, not ours.
 */
export async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? -1);
  if (declared > max) throw new Error(`${declared} bytes exceeds the ${max} byte ceiling`);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new Error(`the body exceeds the ${max} byte ceiling`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
