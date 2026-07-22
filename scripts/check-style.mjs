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

const EM_DASH = String.fromCharCode(0x2014);
const DEFERRED_WORK_MARKERS = ['TO' + 'DO', 'FIX' + 'ME'];
const CHECKED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.md',
  '.json',
  '.yml',
  '.yaml',
]);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.metis', 'test-results', 'playwright-report']);
const SKIP_FILES = new Set(['package-lock.json']);

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

export function findStyleViolations(rootDir) {
  const violations = [];
  for (const file of walk(rootDir)) {
    if (!CHECKED_EXTENSIONS.has(extname(file))) continue;
    if (SKIP_FILES.has(file.split('/').pop() ?? '')) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes(EM_DASH)) {
      violations.push({ file, rule: 'no-em-dash' });
    }
    for (const marker of DEFERRED_WORK_MARKERS) {
      if (text.includes(marker)) {
        violations.push({ file, rule: `no-${marker.toLowerCase()}` });
      }
    }
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = findStyleViolations(process.cwd());
  if (violations.length > 0) {
    console.error('Style violations:');
    for (const v of violations) console.error(`  [${v.rule}] ${v.file}`);
    process.exit(1);
  }
  console.log('Style checks passed: no em dash, no deferred-work markers.');
}
