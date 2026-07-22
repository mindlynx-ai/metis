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

function normaliseIp(ip: string): string {
  if (isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower.startsWith('::ffff:')) return lower;
    try {
      return new URL(`http://[${ip}]`).hostname.slice(1, -1).toLowerCase();
    } catch {
      return lower;
    }
  }
  return ip;
}

/** RFC1918, loopback, link-local and IPv6 reserved ranges. */
export function isBlockedIp(rawIp: string): boolean {
  const ip = normaliseIp(rawIp);
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip.startsWith('172.')) {
    const second = Number(ip.split('.')[1] ?? '0');
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('0.')) return true;
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  ) {
    return true;
  }
  if (lower.startsWith('::ffff:')) {
    return isBlockedIp(lower.slice('::ffff:'.length));
  }
  return false;
}

export interface SsrfCheck {
  allowed: boolean;
  reason?: string;
}

export async function checkUrlForSsrf(rawUrl: string, allowedHosts?: string[]): Promise<SsrfCheck> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `invalid_url: "${rawUrl}" is not a valid URL` };
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

async function fetchFollowingGuardedRedirects(
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
    const nextUrl = new URL(location, currentUrl).toString();
    const check = await checkUrlForSsrf(nextUrl, allowedHosts);
    if (!check.allowed) {
      throw new Error(`ssrf_blocked redirect to "${nextUrl}": ${check.reason}`);
    }
    currentUrl = nextUrl;
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
