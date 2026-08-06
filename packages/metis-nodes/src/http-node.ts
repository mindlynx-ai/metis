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
 * The http/api node, ported from the origin apiNode.ts with
 * the Helix S2S signing paths removed. Direct fetch with an SSRF guard:
 *
 *   1. Scheme allowlist: http and https only.
 *   2. Host allowlist: cfg.allowedHosts short-circuits every other
 *      check, and is the explicit opt-in for private or loopback
 *      targets (Metis is local-first, so local stubs are legitimate
 *      but must be named).
 *   3. Literal-IP and DNS-resolution checks against the RFC1918,
 *      loopback, link-local, and IPv6 reserved blocklist; any blocked
 *      resolved address rejects the request.
 *   4. Redirects are followed manually (max 5 hops) and every hop is
 *      re-checked, so a redirect cannot bypass the guard.
 *
 * Any HTTP response completes the node with { status, ok, data };
 * transport errors, timeouts and SSRF rejections fail it.
 */
import { lookup as dnsLookup } from 'node:dns';
import { isIP, isIPv6 } from 'node:net';
import { promisify } from 'node:util';
import { stateEnvelope, type NodeHandler } from '@mindlynx/metis-ports';

const lookupAsync = promisify(dnsLookup);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECT_HOPS = 5;

export interface HttpNodeConfig {
  method?: string;
  url?: string;
  headers?: unknown;
  body?: unknown;
  timeout?: number;
  timeoutMs?: number;
  retries?: number;
  retryDelay?: number;
  allowedHosts?: string[];
}

function headersFromRows(rows: unknown[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { key, value, enabled } = row as { key?: string; value?: string; enabled?: boolean };
    if (typeof key === 'string' && key.trim() !== '' && enabled !== false) {
      result[key.trim()] = typeof value === 'string' ? value : '';
    }
  }
  return result;
}

/** Accept the array {key, value, enabled} format and the legacy record format. */
export function resolveHeaders(headers: unknown): Record<string, string> {
  if (!headers) return {};
  if (Array.isArray(headers)) return headersFromRows(headers);
  if (typeof headers === 'object') {
    return Object.fromEntries(
      Object.entries(headers as Record<string, unknown>)
        .filter(([key]) => typeof key === 'string' && key !== '')
        .map(([key, value]) => [key, typeof value === 'string' ? value : String(value ?? '')]),
    );
  }
  return {};
}

/** Unwrap the UI body envelope { type: 'json'|'raw'|'text', content }. */
export function unwrapBody(body: unknown): unknown {
  if (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    'type' in (body as Record<string, unknown>) &&
    'content' in (body as Record<string, unknown>)
  ) {
    const kind = String((body as { type?: unknown }).type ?? '').toLowerCase();
    if (kind === 'json' || kind === 'raw' || kind === 'text' || kind === '') {
      return (body as { content?: unknown }).content;
    }
  }
  return body;
}

export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  retryDelayMs: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  throw lastError;
}

/** A dotted quad as a 32-bit number, or undefined if it is not one. */
function dottedToInt(text: string): number | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * An IPv6 literal as its eight 16-bit groups, or undefined if it is not one.
 * A trailing dotted quad is rewritten to the two groups it stands for, so the
 * "::ffff:1.2.3.4" and "::ffff:102:304" spellings of one address land on the
 * same numbers - which is the whole point: `new URL()` hands the guard the
 * second spelling whatever the author typed.
 */
function ipv6Groups(rawIp: string): number[] | undefined {
  let text = (rawIp.split('%')[0] ?? '').toLowerCase(); // a zone id is not part of the address
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const value = dottedToInt(dotted[1] ?? '');
    if (value === undefined) return undefined;
    text = `${text.slice(0, dotted.index)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const [left, right, extra] = text.split('::');
  if (extra !== undefined) return undefined;
  const split = (part: string) => (part === '' ? [] : part.split(':'));
  const head = split(left ?? '');
  const tail = right === undefined ? [] : split(right);
  const gap = 8 - head.length - tail.length;
  if (right !== undefined && gap < 0) return undefined;
  const hextets = right === undefined ? head : [...head, ...Array<string>(gap).fill('0'), ...tail];
  if (hextets.length !== 8) return undefined;
  const groups = hextets.map((hextet) => (/^[0-9a-f]{1,4}$/.test(hextet) ? Number.parseInt(hextet, 16) : NaN));
  return groups.some(Number.isNaN) ? undefined : groups;
}

/**
 * The IPv4 blocklist as [network, mask] pairs. Integer ranges rather than
 * string prefixes: "169.254." matches nothing once an address has been through
 * a normal form, and the ranges an attacker reaches for (CGNAT, the IETF
 * protocol block, multicast) have no tidy prefix to match on at all.
 */
/* eslint-disable sonarjs/no-hardcoded-ip -- this list IS the hardcoded addresses */
const BLOCKED_V4: ReadonlyArray<readonly [number, number]> = (
  [
    ['0.0.0.0', 8], //         "this network"
    ['10.0.0.0', 8], //        RFC1918
    ['100.64.0.0', 10], //     CGNAT - reaches a carrier's own estate
    ['127.0.0.0', 8], //       loopback
    ['169.254.0.0', 16], //    link-local, and the cloud metadata service
    ['172.16.0.0', 12], //     RFC1918
    ['192.0.0.0', 24], //      IETF protocol assignments
    ['192.168.0.0', 16], //    RFC1918
    ['198.18.0.0', 15], //     benchmarking
    ['224.0.0.0', 4], //       multicast
    ['240.0.0.0', 4], //       reserved, and 255.255.255.255 broadcast
  ] as const
).map(([network, bits]) => [dottedToInt(network) ?? 0, (-1 << (32 - bits)) >>> 0] as const);
/* eslint-enable sonarjs/no-hardcoded-ip */

/**
 * Private, loopback, link-local, carrier and reserved ranges - refused however
 * the address is spelled. Both IPv6 forms that embed an IPv4 address
 * (IPv4-mapped `::ffff:0:0/96` and the deprecated IPv4-compatible `::/96`) are
 * reduced to that address and tested as IPv4, so there is one blocklist rather
 * than one per notation.
 *
 * An address this cannot parse is BLOCKED, not allowed: the callers only ever
 * pass something `isIP` or the resolver already vouched for, so an unparseable
 * one means the guard has lost track of what it is looking at.
 */
export function isBlockedIp(rawIp: string): boolean {
  const direct = dottedToInt(rawIp);
  if (direct !== undefined) return isBlockedV4(direct);
  if (!isIPv6(rawIp)) return true;
  const groups = ipv6Groups(rawIp);
  if (!groups) return true;
  const [a, b, c, d, e, f, g, h] = groups as [number, number, number, number, number, number, number, number];
  // 64:ff9b::/96, the well-known NAT64 prefix: an IPv4 destination wearing an
  // IPv6 hat, translated by whichever gateway sits in front of us.
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return true;
  const embedsV4 = a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0 || f === 0xffff);
  if (embedsV4) return isBlockedV4(g * 0x10000 + h);
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7  unique local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((a & 0xff00) === 0xff00) return true; // ff00::/8  multicast
  return false;
}

function isBlockedV4(address: number): boolean {
  return BLOCKED_V4.some(([network, mask]) => ((address ^ network) & mask) === 0);
}

export interface SsrfCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Every refusal below names scheme and host and nothing else. A refusal becomes
 * the node's message, a stored log row and the run's failureReason, and the URL
 * this is handed has ALREADY been through secret resolution - so echoing
 * `https://api.example/v1?key=<resolved>` would write a live key into the run
 * history and the Temporal event history. The host is the fact an author needs
 * to see; the query string never is.
 */
export async function checkUrlForSsrf(rawUrl: string, allowedHosts?: string[]): Promise<SsrfCheck> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Deliberately says nothing about the string: it did not parse, so there is
    // no host to name, and the raw value may be a resolved secret.
    return { allowed: false, reason: 'invalid_url: the configured url is not a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: `blocked scheme "${parsed.protocol}"` };
  }
  const host = parsed.hostname.toLowerCase();
  if (allowedHosts && allowedHosts.length > 0) {
    if (allowedHosts.some((allowed) => allowed.toLowerCase() === host)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `ssrf_blocked: host "${host}" is not in allowedHosts` };
  }
  const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(bareHost)) {
    return isBlockedIp(bareHost)
      ? { allowed: false, reason: `ssrf_blocked: address ${bareHost} is in a blocked range` }
      : { allowed: true };
  }
  try {
    const records = await lookupAsync(bareHost, { all: true });
    const blocked = records.find((record) => isBlockedIp(record.address));
    if (blocked) {
      return {
        allowed: false,
        reason: `ssrf_blocked: "${bareHost}" resolves to blocked address ${blocked.address}`,
      };
    }
    return { allowed: true };
  } catch {
    return { allowed: false, reason: `ssrf_blocked: could not resolve host "${bareHost}"` };
  }
}

/** Exported because every fetch of an author-supplied URL needs this, not just
 *  the http node: a source that 302s to 169.254.169.254 would otherwise walk
 *  straight past a guard that only ever looked at the first hop. */
export async function fetchFollowingGuardedRedirects(
  url: string,
  init: RequestInit,
  allowedHosts: string[] | undefined,
  signal: AbortSignal,
): Promise<Response> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    const response = await fetch(currentUrl, { ...init, redirect: 'manual', signal });
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    const location = response.headers.get('location');
    if (!location) return response;
    const next = new URL(location, currentUrl);
    const check = await checkUrlForSsrf(next.toString(), allowedHosts);
    if (!check.allowed) {
      // Host only: a relative Location resolves against the CURRENT url, so the
      // full next url can still carry the caller's query string, secrets and all.
      throw new Error(`ssrf_blocked redirect to ${next.protocol}//${next.host}: ${check.reason}`);
    }
    currentUrl = next.toString();
  }
  throw new Error(`too many redirects (more than ${MAX_REDIRECT_HOPS})`);
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createHttpNodeHandler(): NodeHandler {
  return async (ctx) => {
    const config = ctx.nodeRef.config as HttpNodeConfig;
    const url = String(config.url ?? '');
    const check = await checkUrlForSsrf(url, config.allowedHosts);
    if (!check.allowed) {
      return { status: 400, message: check.reason ?? 'ssrf_blocked' };
    }

    const method = String(config.method ?? 'GET').toUpperCase();
    const headers = resolveHeaders(config.headers);
    // The node's policy opted in to idempotency: tell the far side, unless
    // the author set the header themselves.
    if (ctx.idempotencyKey && !Object.keys(headers).some((h) => h.toLowerCase() === 'idempotency-key')) {
      headers['Idempotency-Key'] = ctx.idempotencyKey;
    }
    const body = unwrapBody(config.body);
    const timeoutMs = Number(config.timeout ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const retries = Number(config.retries ?? 0);
    const retryDelay = Number(config.retryDelay ?? 250);

    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
      if (typeof body === 'string') {
        init.body = body;
      } else {
        init.body = JSON.stringify(body);
        (init.headers as Record<string, string>)['content-type'] ??= 'application/json';
      }
    }

    try {
      const response = await executeWithRetry(
        async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            return await fetchFollowingGuardedRedirects(
              url,
              init,
              config.allowedHosts,
              controller.signal,
            );
          } finally {
            clearTimeout(timer);
          }
        },
        retries,
        retryDelay,
      );
      const data = await parseResponse(response);
      const output = {
        status: response.status,
        ok: response.ok,
        data,
        headers: Object.fromEntries(response.headers.entries()),
      };
      return { status: 200, message: 'ok', nodeData: stateEnvelope(ctx.nodeRef.id, ctx.nodeRef.type, output) };
    } catch (error) {
      return { status: 502, message: error instanceof Error ? error.message : String(error) };
    }
  };
}
