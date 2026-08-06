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
 * The SSRF guard on its own, away from the http node's server fixture: four
 * modules share it (http, s3, s3-client, connection-tester), so a hole here is
 * a hole in every author-supplied URL the product fetches.
 *
 * The IPv6 cases are the ones that matter. `new URL()` does not hand the guard
 * the address an author typed; it hands back its own normal form, and for an
 * IPv4-mapped address that form is hex - `[::ffff:169.254.169.254]` arrives as
 * `[::ffff:a9fe:a9fe]`. A guard that pattern-matches text sees a string it has
 * no case for and lets the metadata service through.
 */
import { describe, it, expect } from 'vitest';
import { checkUrlForSsrf, isBlockedIp } from '../http-node.js';

/** What `new URL()` actually produces for a bracketed IPv6 literal. */
const hostnameOf = (url: string) => new URL(url).hostname;

describe('SSRF guard: IPv6 spellings of a blocked IPv4 address', () => {
  it('normalises the form new URL() produces, not just the dotted one', () => {
    expect(hostnameOf('http://[::ffff:169.254.169.254]/')).toBe('[::ffff:a9fe:a9fe]');
  });

  it.each([
    ['169.254.169.254', 'IMDS, dotted'],
    ['::ffff:169.254.169.254', 'IMDS, mapped and dotted'],
    ['::ffff:a9fe:a9fe', 'IMDS, mapped and hex - what new URL() emits'],
    ['::ffff:7f00:1', 'loopback, mapped and hex'],
    ['::ffff:127.0.0.1', 'loopback, mapped and dotted'],
    ['::ffff:a00:1', '10.0.0.1, mapped and hex'],
    ['::ffff:c0a8:1', '192.168.0.1, mapped and hex'],
    ['::ffff:ac10:1', '172.16.0.1, mapped and hex'],
    ['::7f00:1', 'loopback, IPv4-compatible'],
    ['::a9fe:a9fe', 'IMDS, IPv4-compatible'],
    ['::1', 'IPv6 loopback'],
    ['::', 'unspecified'],
    ['fd00::1', 'unique local'],
    ['fe80::1', 'link local'],
  ])('blocks %s (%s)', (address) => {
    expect(isBlockedIp(address)).toBe(true);
  });
});

describe('SSRF guard: IPv4 ranges that were never covered', () => {
  it.each([
    ['100.64.0.1', 'CGNAT, 100.64.0.0/10'],
    ['100.127.255.254', 'CGNAT, top of range'],
    ['192.0.0.1', 'IETF protocol assignments, 192.0.0.0/24'],
    ['198.18.0.1', 'benchmarking, 198.18.0.0/15'],
    ['198.19.255.255', 'benchmarking, top of range'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast, top of range'],
    ['255.255.255.255', 'broadcast'],
    ['240.0.0.1', 'reserved'],
  ])('blocks %s (%s)', (address) => {
    expect(isBlockedIp(address)).toBe(true);
  });

  it('blocks the NAT64 well-known prefix', () => {
    expect(isBlockedIp('64:ff9b::1')).toBe(true);
    expect(isBlockedIp('64:ff9b::a9fe:a9fe')).toBe(true);
  });

  it('still allows ordinary public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '100.63.255.255', '100.128.0.1', '2606:4700::1111']) {
      expect(isBlockedIp(address)).toBe(false);
    }
  });
});

describe('SSRF guard: through a URL, the way a node reaches it', () => {
  it.each([
    'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://[::ffff:7f00:1]:9999/x',
    'http://[::7f00:1]/x',
    'http://100.64.0.1/x',
    'http://[64:ff9b::a9fe:a9fe]/latest/meta-data/',
  ])('refuses %s', async (url) => {
    const check = await checkUrlForSsrf(url);
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/blocked/i);
  });
});

describe('SSRF guard: failure reasons carry no secret material', () => {
  it('does not echo the URL of an unparseable target', async () => {
    const check = await checkUrlForSsrf('http://:not a url/?key=sk-live-SHOULD-NOT-APPEAR');
    expect(check.allowed).toBe(false);
    expect(check.reason).not.toContain('sk-live-SHOULD-NOT-APPEAR');
  });

  it('names only host and scheme when a resolved URL is refused', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/?key=sk-live-SHOULD-NOT-APPEAR',
      'ftp://example.test/file?key=sk-live-SHOULD-NOT-APPEAR',
      'http://example.test/x?key=sk-live-SHOULD-NOT-APPEAR',
    ]) {
      const check = await checkUrlForSsrf(url, ['allowed.test']);
      expect(check.reason).not.toContain('sk-live-SHOULD-NOT-APPEAR');
    }
  });
});
