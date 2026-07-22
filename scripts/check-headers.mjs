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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADER_MARKER = 'Licensed under the Apache License, Version 2.0';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.metis', 'test-results', 'playwright-report']);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walk(full);
    } else {
      yield full;
    }
  }
}

export function findMissingHeaders(rootDir) {
  const missing = [];
  for (const file of walk(rootDir)) {
    if (!SOURCE_EXTENSIONS.has(extname(file))) continue;
    const head = readFileSync(file, 'utf8').slice(0, 1200);
    if (!head.includes(HEADER_MARKER)) missing.push(file);
  }
  return missing;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const missing = findMissingHeaders(root);
  if (missing.length > 0) {
    console.error('Files missing the Apache-2.0 header:');
    for (const file of missing) console.error(`  ${file}`);
    process.exit(1);
  }
  console.log('All source files carry the Apache-2.0 header.');
}
