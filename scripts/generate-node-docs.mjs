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
 * Generate docs/nodes/<type>.md from the catalogue - the single source of
 * truth for the in-app Guide tab and the repo's node reference. Run:
 *
 *   node scripts/generate-node-docs.mjs
 *
 * Gate 7 fails if the result differs from what is committed, so a catalogue
 * edit cannot ship with a stale reference beside it.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderNodeDocs } from './node-docs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalogue = JSON.parse(
  readFileSync(join(root, 'packages/metis-catalogue/src/nodeTypes.v1.json'), 'utf8'),
);
const outDir = join(root, 'docs', 'nodes');
mkdirSync(outDir, { recursive: true });
for (const stale of readdirSync(outDir)) {
  if (stale.endsWith('.md')) unlinkSync(join(outDir, stale));
}
const files = renderNodeDocs(catalogue);
for (const [name, contents] of files) writeFileSync(join(outDir, name), contents);
console.log(`wrote ${files.size - 1} node docs + index to docs/nodes/`);
