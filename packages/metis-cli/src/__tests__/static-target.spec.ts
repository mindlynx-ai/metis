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
 * What every URL on the origin resolves to. This decides whether the server
 * has a 404 at all, which turned out to matter beyond tidiness: an origin that
 * answers 200 with the same HTML for every path, /robots.txt included, is what
 * a cloaking or doorway page looks like to a reputation scanner.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveStaticTarget } from '../control-server.js';

const DIR = '/app/editor';
const shell = join(DIR, 'index.html');
/** Only the files a built editor really has. */
const present = new Set([join(DIR, 'assets/index-abc.js'), join(DIR, 'favicon.svg'), shell]);
const exists = (path: string) => present.has(path);

describe('resolveStaticTarget', () => {
  it('serves the shell at the root', () => {
    expect(resolveStaticTarget(DIR, '', exists)).toEqual({ file: shell });
  });

  it('serves the shell for client-side routes, which carry no extension', () => {
    for (const route of ['workflows', 'connectors', 'operate', 'activity', 'reviews']) {
      expect(resolveStaticTarget(DIR, route, exists)).toEqual({ file: shell });
    }
  });

  it('serves a real asset when it is really there', () => {
    expect(resolveStaticTarget(DIR, 'assets/index-abc.js', exists)).toEqual({
      file: join(DIR, 'assets/index-abc.js'),
    });
  });

  it('404s a missing file rather than answering with the shell', () => {
    // The exact case that made the origin look like it had no 404: robots.txt
    // came back 200 as text/html, and so did anything else anybody probed for.
    for (const missing of ['robots.txt', 'wp-login.php', 'assets/index-GONE.js', 'sitemap.xml']) {
      expect(resolveStaticTarget(DIR, missing, exists)).toEqual({ notFound: true });
    }
  });

  it('serves robots.txt once it exists, which is the point of shipping one', () => {
    const withRobots = (path: string) => present.has(path) || path === join(DIR, 'robots.txt');
    expect(resolveStaticTarget(DIR, 'robots.txt', withRobots)).toEqual({
      file: join(DIR, 'robots.txt'),
    });
  });
});

describe('an unmatched API path is a missing endpoint, not a client route', () => {
  it('404s /api/* instead of answering with the shell', () => {
    // This is what made a dead endpoint read as a live one: GET /api/account on
    // an instance with no cloud configured came back 200 text/html, so a client
    // that does not check the content type sees success. The same absent route
    // answered a correct 404 to POST, which made the two disagree.
    for (const url of ['api/account', 'api/definitely-not-a-route', 'api/v2/orders', 'api']) {
      expect(resolveStaticTarget(DIR, url, exists)).toEqual({ notFound: true });
      expect(resolveStaticTarget(DIR, `/${url}`, exists)).toEqual({ notFound: true });
    }
  });

  it('does not swallow a client route that merely starts with the letters api', () => {
    for (const route of ['apiary', 'api-docs', 'apis']) {
      expect(resolveStaticTarget(DIR, route, exists)).toEqual({ file: shell });
    }
  });
});

describe('a request can never read outside the editor directory', () => {
  // This route is mounted outside the authenticated scope, so anything it will
  // return it returns to anyone who can reach the port. It used to hand back
  // .metis/credential.key - the key sitting beside the encrypted credential
  // vault - because `join` normalises `..` away instead of refusing it, and
  // because a path with an extension is never rerouted to the shell.
  //
  // Every input below is in DECODED form, which is what this function is handed:
  // Fastify's router percent-decodes a wildcard param before the handler sees
  // it, so `/..%2f..%2f.metis%2fcredential.key` arrives here as
  // `../../.metis/credential.key`. Asserting on the still-encoded spelling would
  // test a case that cannot reach this function, and would wrongly demand a
  // refusal: `..%2f..` with no real separator is merely an odd filename that
  // legitimately sits inside the directory.
  //
  // `exists` returns TRUE for everything here on purpose: the containment check
  // has to refuse the path on its shape alone, never on the file happening to
  // be absent on the machine the test runs on.
  const anything = () => true;

  it('refuses a traversal', () => {
    for (const url of [
      '../.metis/credential.key',
      '../../../.metis/credential.key',
      '../../../../../../etc/passwd',
      '../../.metis/credentials.enc',
      '../../.metis/metis.db',
      'assets/../../.metis/metis.db',
      // The leading-slash spelling, since the function accepts both.
      '/../../.metis/credential.key',
    ]) {
      expect(resolveStaticTarget(DIR, url, anything), url).toEqual({ notFound: true });
    }
  });

  it('refuses a sibling directory that merely shares the prefix', () => {
    // /app/editor-secrets starts with /app/editor, so a bare startsWith without
    // the separator would have let this through.
    expect(resolveStaticTarget(DIR, '../editor-secrets/key.pem', anything)).toEqual({
      notFound: true,
    });
  });

  it('still serves a legitimate nested asset', () => {
    // The guard must not cost us the ordinary case: a real path that stays
    // inside, including one that walks up and back down within the directory.
    expect(resolveStaticTarget(DIR, 'assets/index-abc.js', exists)).toEqual({
      file: join(DIR, 'assets/index-abc.js'),
    });
    expect(resolveStaticTarget(DIR, 'assets/../favicon.svg', exists)).toEqual({
      file: join(DIR, 'favicon.svg'),
    });
  });
});
