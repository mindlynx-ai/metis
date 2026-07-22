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
import { join, relative, extname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { walkFiles } from './lib/scan.mjs';

// Patterns are assembled from fragments so this file never contains the
// banned identifiers it hunts for.
const BANNED_PATTERNS = [
  { name: 'pilot-table-prefix', pattern: new RegExp('helix-pi' + 'lot-') },
  { name: 'cluster-internal-host', pattern: new RegExp('svc\\.clu' + 'ster\\.local') },
  { name: 'internal-vpc-address', pattern: new RegExp('\\b10\\.6' + '0\\.\\d{1,3}\\.\\d{1,3}\\b') },
  { name: 'internal-shared-secret', pattern: new RegExp('INTERNAL_SH' + 'ARED_SECRET') },
  { name: 'aws-access-key', pattern: new RegExp('AK' + 'IA[0-9A-Z]{16}') },
  { name: 'private-key-block', pattern: new RegExp('-----BEGIN [A-Z ]*PRIV' + 'ATE KEY-----') },
];

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.env',
  '.sh',
]);
const FIXTURES_PREFIX = 'gates/fixtures';
const SKIP_FILES = new Set(['package-lock.json']);

export function runIdentifierScanGate(rootDir) {
  const allowlistPath = join(rootDir, 'gates', 'scan-allowlist.json');
  const allowlist = existsSync(allowlistPath)
    ? JSON.parse(readFileSync(allowlistPath, 'utf8'))
    : [];
  const violations = [];
  for (const file of walkFiles(rootDir, [FIXTURES_PREFIX])) {
    if (!TEXT_EXTENSIONS.has(extname(file))) continue;
    const rel = relative(rootDir, file);
    if (SKIP_FILES.has(rel.split('/').pop() ?? '')) continue;
    if (allowlist.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
    const text = readFileSync(file, 'utf8');
    for (const banned of BANNED_PATTERNS) {
      if (banned.pattern.test(text)) {
        violations.push({
          file: rel,
          rule: 'banned-identifier',
          detail: banned.name,
        });
      }
    }
  }
  return violations;
}
