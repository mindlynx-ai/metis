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
 * Publish every @mindlynx/metis-* package in dependency order. DRY RUN by
 * default; pass --publish to actually publish (requires `npm login` with
 * publish rights on the @mindlynx org). All packages must share ONE version -
 * bump them together with `npm version <v> --workspaces` before publishing.
 *
 *   node scripts/publish-all.mjs              # dry run (npm publish --dry-run)
 *   node scripts/publish-all.mjs --publish    # the real thing
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publish = process.argv.includes('--publish');

// Run through npm's own absolute entrypoint (set when invoked via npm run) -
// no PATH lookup. Run as: npm run release:dry / npm run release.
const npmEntry = process.env.npm_execpath;
if (!npmEntry) {
  console.error('run this via npm: "npm run release:dry" or "npm run release"');
  process.exit(1);
}
const npm = (args, options) => execFileSync(process.execPath, [npmEntry, ...args], options);

// Dependency order: ports first, the CLI (which depends on everything) last.
const ORDER = [
  'metis-ports',
  'metis-data-gateway',
  'metis-catalogue',
  'metis-engine',
  'metis-nodes',
  'metis-orchestrator',
  'metis-core',
  'metis-editor',
  'metis-cli',
];

const versions = new Set(
  ORDER.map((pkg) =>
    JSON.parse(readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8')).version,
  ),
);
if (versions.size !== 1) {
  console.error(`versions diverge across packages: ${[...versions].join(', ')} - bump together first`);
  process.exit(1);
}
const version = [...versions][0];
console.log(`${publish ? 'PUBLISHING' : 'dry run'} @mindlynx/* at ${version}\n`);

npm(['run', 'build', '--workspaces', '--if-present'], { cwd: root, stdio: 'inherit' });
for (const pkg of ORDER) {
  const dir = join(root, 'packages', pkg);
  console.log(`\n== @mindlynx/${pkg} ==`);
  npm(['publish', '--access', 'public', ...(publish ? [] : ['--dry-run'])], { cwd: dir, stdio: 'inherit' });
}
console.log(`\n${publish ? 'published' : 'dry run complete'}: 9 packages at ${version}`);
