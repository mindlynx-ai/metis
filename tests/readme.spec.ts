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
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');

describe('README quickstart', () => {
  it('covers the docker-compose hero path with the real compose command', () => {
    expect(readme).toContain('docker compose -f compose/docker-compose.yml up');
  });

  it('leads the developer loop with the path that works today', () => {
    // The npx quickstart used to come first and returned a 404: nothing under
    // @mindlynx is published. The source path is the one a stranger can follow,
    // so it is the one in the code fence.
    const loop = readme.slice(readme.indexOf('## Quickstart: from source'));
    expect(loop.indexOf('node packages/metis-cli/dist/bin.js init')).toBeGreaterThan(-1);
    expect(loop).toContain('node packages/metis-cli/dist/bin.js up');
    expect(loop).toContain('node packages/metis-cli/dist/bin.js run hello');
    expect(loop.indexOf('npm ci && npm run build')).toBeLessThan(
      loop.indexOf('npx @mindlynx/metis-cli'),
    );
  });

  it('marks the npx route as not yet published rather than offering it', () => {
    const claim = readme.slice(readme.indexOf('npx @mindlynx/metis-cli') - 400);
    expect(claim).toMatch(/not live yet|404|not published/i);
  });

  it('names the prerequisites that stop an install dead', () => {
    const prereqs = readme.slice(
      readme.indexOf('## Prerequisites'),
      readme.indexOf('## Quickstart'),
    );
    expect(prereqs).toContain('22.13'); // node:sqlite, the default datastore
    expect(prereqs).toContain('isolated-vm'); // needs a C++ toolchain
    expect(prereqs).toContain('7233'); // the port the README never mentioned
  });

  it('explains Temporal in roughly 200 words', () => {
    const start = readme.indexOf('## What is Temporal');
    const end = readme.indexOf('##', start + 1);
    const words = readme.slice(start, end).split(/\s+/).filter(Boolean).length;
    expect(words).toBeGreaterThan(120);
    expect(words).toBeLessThan(320);
  });

  it('has a first-workflow tutorial that needs no Temporal knowledge', () => {
    const start = readme.indexOf('## Your first workflow');
    expect(start).toBeGreaterThan(0);
    const tutorial = readme.slice(start, readme.indexOf('##', start + 1));
    expect(tutorial).toMatch(/Webhook Start/);
    expect(tutorial).toMatch(/Code/);
    expect(tutorial).toMatch(/Run/);
    // The commands the tutorial references exist.
    expect(readme).toContain('metis up');
  });

  it('names the referenced compose file and it exists', () => {
    expect(() =>
      readFileSync(join(repoRoot, 'compose', 'docker-compose.yml'), 'utf8'),
    ).not.toThrow();
  });
});
