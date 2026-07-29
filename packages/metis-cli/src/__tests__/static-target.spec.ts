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
