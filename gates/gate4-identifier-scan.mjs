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
import { join, relative, extname, basename } from 'node:path';
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

/**
 * Internal product names, checked only in text somebody reads: markdown, the
 * catalogue (whose strings render in the editor's inspector and Guide tab),
 * and rendered SVG diagrams (every label is stored as literal text inside the
 * file, so a diagram leaks a name exactly as the prose beside it does).
 * A leak here shipped once, in the Data step's `output` description.
 *
 * They are deliberately NOT checked in source, where the same words are the
 * closed-type namespace the open tree names so that it can police it: gate 1
 * bans importing those modules, gate 3 bans shipping node types with those
 * prefixes, loader.ts lists them, and the catalogue spec asserts they are
 * absent. Scanning code would flag the guards and still miss the prose.
 */
const PROSE_PATTERNS = [
  { name: 'internal-product-name', pattern: new RegExp('tach' + 'yon|cor' + 'tex', 'i') },
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
  '.sh',
  '.sql',
  '.pem',
  '.example',
  // A rendered diagram is text: mermaid-cli writes every node label into the
  // SVG verbatim. docs/diagrams/*.svg ships to GitHub and the docs site, so an
  // internal host or product name drawn into a box would have gone out
  // unscanned - the same extension-shaped blind spot as .env below.
  '.svg',
]);
// Extension is the wrong question for the files most likely to hold a key.
// `.env` sat in the extension set for months and matched nothing, because
// extname('.env') is ''; the same blind spot hid the Dockerfile, the Caddyfile
// and the deploy state file.
const TEXT_FILENAME_PREFIXES = ['.env', 'Dockerfile'];
const TEXT_FILENAMES = new Set(['Caddyfile', '.state']);
const FIXTURES_PREFIX = 'gates/fixtures';
// Internal planning notes are gitignored and gate 6 keeps them out of the
// index, so they cannot ship. They are still swept for secrets; only the
// product names are excused, since naming those is what they are for.
const INTERNAL_DOCS_PREFIX = 'docs/internal';
const SKIP_FILES = new Set(['package-lock.json']);

function isScannable(name) {
  return (
    TEXT_EXTENSIONS.has(extname(name)) ||
    TEXT_FILENAMES.has(name) ||
    TEXT_FILENAME_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function isProse(rel, name) {
  if (/^nodeTypes.*\.json$/.test(name) || name.endsWith('.svg')) return true;
  return name.endsWith('.md') && !rel.startsWith(`${INTERNAL_DOCS_PREFIX}/`);
}

export function runIdentifierScanGate(rootDir) {
  const allowlistPath = join(rootDir, 'gates', 'scan-allowlist.json');
  const allowlist = existsSync(allowlistPath)
    ? JSON.parse(readFileSync(allowlistPath, 'utf8'))
    : [];
  const violations = [];
  for (const file of walkFiles(rootDir, [FIXTURES_PREFIX])) {
    const name = basename(file);
    if (!isScannable(name) || SKIP_FILES.has(name)) continue;
    const rel = relative(rootDir, file);
    if (allowlist.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
    const text = readFileSync(file, 'utf8');
    const patterns = isProse(rel, name) ? [...BANNED_PATTERNS, ...PROSE_PATTERNS] : BANNED_PATTERNS;
    for (const banned of patterns) {
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
