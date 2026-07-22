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
 * The "don't fall behind" check: compare every @mindlynx/metis-* package's
 * local version against what npm actually serves. Fails when the registry is
 * BEHIND the repo (you shipped features without publishing) or ahead of it
 * (the repo was released from somewhere else). Warns-but-passes while nothing
 * is published yet, so it can sit in CI before the first release.
 *
 *   node scripts/check-publish-freshness.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');
let stale = 0;
let unpublished = 0;

for (const pkg of readdirSync(packagesDir).filter((name) => name.startsWith('metis-'))) {
  const manifest = JSON.parse(readFileSync(join(packagesDir, pkg, 'package.json'), 'utf8'));
  let published;
  try {
    const npmEntry = process.env.npm_execpath;
    if (!npmEntry) throw new Error('run via npm: "npm run check:publish"');
    published = execFileSync(process.execPath, [npmEntry, 'view', manifest.name, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    published = undefined;
  }
  if (!published) {
    unpublished += 1;
    console.log(`~ ${manifest.name}: NOT PUBLISHED (local ${manifest.version})`);
  } else if (published !== manifest.version) {
    stale += 1;
    console.error(`x ${manifest.name}: npm has ${published}, repo has ${manifest.version}`);
  } else {
    console.log(`+ ${manifest.name}: ${published} (in sync)`);
  }
}

if (stale > 0) {
  console.error(`\n${stale} package(s) out of sync with npm - run scripts/publish-all.mjs after a version bump`);
  process.exit(1);
}
if (unpublished > 0) {
  console.log(`\n${unpublished} package(s) not yet published - fine before the first release`);
}
console.log('publish freshness ok');
