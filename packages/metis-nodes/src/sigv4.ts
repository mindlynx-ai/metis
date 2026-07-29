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
 * AWS Signature Version 4, by hand, over node:crypto. Metis ships no AWS SDK
 * (a build gate enforces it), and that constraint buys the thing the SDK could
 * not: signing the plain REST API means the same code authenticates against
 * MinIO, Cloudflare R2, Backblaze B2 and anything else that speaks S3.
 *
 * Every stage is exported separately because SigV4 fails silently and
 * identically whichever stage is wrong: a stray newline in the canonical
 * request and a bad signing key both surface as one opaque 403. The stages are
 * pinned individually against AWS's published vectors, so a break says where.
 *
 * Two S3-specific choices are deliberate:
 *   - the canonical URI is the path AS SENT. Every other service normalises
 *     and double-encodes it; S3 signs it raw, so the caller encodes the key
 *     once when it builds the URL and this module never touches it again.
 *   - the payload hash is explicit. S3 requires x-amz-content-sha256 on every
 *     request, and UNSIGNED-PAYLOAD is a legitimate value, not a shortcut.
 */
import { createHash, createHmac } from 'node:crypto';

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
/** sha256 of the empty string: the payload hash of any request with no body. */
export const EMPTY_PAYLOAD_SHA256 = sha256Hex('');
const ALGORITHM = 'AWS4-HMAC-SHA256';
const TERMINATOR = 'aws4_request';

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials carry a session token, signed as a header/param. */
  sessionToken?: string;
}

export interface SigV4Request {
  method: string;
  /** The URL as it will be sent: its path and query are signed verbatim. */
  url: URL;
  headers?: Record<string, string>;
  /** Hex sha256 of the body, or UNSIGNED-PAYLOAD. Defaults to the empty hash. */
  payloadHash?: string;
  region: string;
  service?: string;
  /** Fixed for tests; a signature is a pure function of its clock. */
  date?: Date;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** RFC3986: encodeURIComponent leaves !'()* alone and AWS does not forgive it. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode an object key for a URL path: every segment escaped, the separators
 *  left alone, so "folder/a b.png" stays two segments and not one. */
export function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

/** The two date forms a signature needs: 20150830T123600Z and 20150830. */
export function amzDates(date: Date): { amzDate: string; dateStamp: string } {
  const amzDate = `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** Sorted, re-encoded query. URLSearchParams decodes on read, so re-encoding
 *  here is what turns whatever form the caller wrote into the one AWS signs. */
export function canonicalQuery(url: URL): string {
  return [...url.searchParams]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

/**
 * The URL as it must go on the wire. URLSearchParams serialises a space as
 * "+" and leaves "*" alone; the canonical query encodes them %20 and %2A. Send
 * url.toString() and a key with a space in it signs one way and arrives the
 * other, for a 403 that only ever reproduces on the keys nobody tested with.
 * So the query is rendered once, canonically, and used for both.
 */
export function canonicalUrl(url: URL): string {
  const query = canonicalQuery(url);
  const search = query === '' ? '' : `?${query}`;
  return `${url.origin}${url.pathname}${search}`;
}

interface CanonicalHeaders {
  canonical: string;
  signed: string;
}

/** Lowercased names, trimmed values with runs of spaces collapsed, sorted. */
export function canonicalHeaders(headers: Record<string, string>): CanonicalHeaders {
  const rows = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return {
    canonical: rows.map(([name, value]) => `${name}:${value}\n`).join(''),
    signed: rows.map(([name]) => name).join(';'),
  };
}

/** Stage 1: the canonical request, the document whose hash is actually signed. */
export function canonicalRequest(
  method: string,
  url: URL,
  headers: Record<string, string>,
  payloadHash: string,
): { text: string; signedHeaders: string } {
  const { canonical, signed } = canonicalHeaders(headers);
  const text = [
    method.toUpperCase(),
    url.pathname === '' ? '/' : url.pathname,
    canonicalQuery(url),
    canonical,
    signed,
    payloadHash,
  ].join('\n');
  return { text, signedHeaders: signed };
}

export function credentialScope(dateStamp: string, region: string, service: string): string {
  return `${dateStamp}/${region}/${service}/${TERMINATOR}`;
}

/** Stage 2: the string to sign. */
export function stringToSign(
  amzDate: string,
  scope: string,
  canonicalRequestText: string,
): string {
  return [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequestText)].join('\n');
}

/** Stage 3: the signing key. Derived per date, region and service, which is
 *  why a leaked signature cannot be replayed against another day or bucket. */
export function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const date = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regional = hmac(date, region);
  const serviced = hmac(regional, service);
  return hmac(serviced, TERMINATOR);
}

/** Stage 4: the signature itself. */
export function sign(
  credentials: SigV4Credentials,
  dateStamp: string,
  region: string,
  service: string,
  toSign: string,
): string {
  return createHmac(
    'sha256',
    signingKey(credentials.secretAccessKey, dateStamp, region, service),
  )
    .update(toSign, 'utf8')
    .digest('hex');
}

/**
 * Header-authenticated signing: returns the headers to send, the caller's own
 * among them. `host` is included because it is signed; fetch sets it from the
 * URL and refuses the explicit one, which is consistent either way.
 */
export function signRequest(
  request: SigV4Request,
  credentials: SigV4Credentials,
): Record<string, string> {
  const service = request.service ?? 's3';
  const { amzDate, dateStamp } = amzDates(request.date ?? new Date());
  const payloadHash = request.payloadHash ?? EMPTY_PAYLOAD_SHA256;
  const headers: Record<string, string> = {
    ...(request.headers ?? {}),
    host: request.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
  };
  const canonical = canonicalRequest(request.method, request.url, headers, payloadHash);
  const scope = credentialScope(dateStamp, request.region, service);
  const signature = sign(
    credentials,
    dateStamp,
    request.region,
    service,
    stringToSign(amzDate, scope, canonical.text),
  );
  return {
    ...headers,
    authorization:
      `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${canonical.signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Query-authenticated signing: a URL that carries its own authorisation and
 * expires. Nothing but the credentials, the request and the clock goes into
 * it, so no bytes and no secret ever leave with the person you hand it to.
 */
export function presignUrl(
  request: SigV4Request & { expiresIn: number },
  credentials: SigV4Credentials,
): string {
  const service = request.service ?? 's3';
  const { amzDate, dateStamp } = amzDates(request.date ?? new Date());
  const scope = credentialScope(dateStamp, request.region, service);
  const url = new URL(request.url.toString());
  // Only host is signed: a presigned URL is opened by a browser, and any other
  // signed header would have to be reproduced by whoever follows the link.
  const headers = { host: url.host, ...(request.headers ?? {}) };
  const { signed } = canonicalHeaders(headers);
  url.searchParams.set('X-Amz-Algorithm', ALGORITHM);
  url.searchParams.set('X-Amz-Credential', `${credentials.accessKeyId}/${scope}`);
  url.searchParams.set('X-Amz-Date', amzDate);
  url.searchParams.set('X-Amz-Expires', String(request.expiresIn));
  if (credentials.sessionToken) {
    url.searchParams.set('X-Amz-Security-Token', credentials.sessionToken);
  }
  url.searchParams.set('X-Amz-SignedHeaders', signed);
  const canonical = canonicalRequest(request.method, url, headers, UNSIGNED_PAYLOAD);
  const signature = sign(
    credentials,
    dateStamp,
    request.region,
    service,
    stringToSign(amzDate, scope, canonical.text),
  );
  return `${canonicalUrl(url)}&X-Amz-Signature=${signature}`;
}
