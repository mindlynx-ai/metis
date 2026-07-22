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
 * Gate 6: shippable-markdown allowlist. The identifier scan (gate 4) catches
 * secrets and infra names, but the real pre-launch risk was internal PLANNING
 * docs quietly shipping (build plans, porting ledgers). Every tracked markdown
 * file at the repo root or under docs/ must be on this list; anything else
 * fails the gate. Package READMEs and generated node docs are allowed by
 * pattern.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ALLOWED = new Set([
  'README.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'RELEASING.md',
  'docs/README.md',
  'docs/adding-a-node.md',
  'docs/architecture.md',
  'docs/connectors.md',
  'docs/running-tests.md',
  'docs/mcp.md',
  'deploy/aws/README.md',
]);

const ALLOWED_PATTERNS = [
  /^packages\/[^/]+\/README\.md$/, // per-package overviews
  /^docs\/nodes\/[^/]+\.md$/, // generated node reference
  /^\.github\//, // issue/PR templates
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'internal', 'test-results', 'playwright-report']);

function walkMarkdown(dir, rootDir, found) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) walkMarkdown(full, rootDir, found);
    else if (name.endsWith('.md')) found.push(relative(rootDir, full));
  }
  return found;
}

export function runDocAllowlistGate(rootDir) {
  const tracked = walkMarkdown(rootDir, rootDir, []);
  return tracked
    .filter((file) => {
      const atRootOrDocs = !file.includes('/') || file.startsWith('docs/') || file.startsWith('deploy/');
      const inScope = atRootOrDocs || /README\.md$/.test(file);
      if (!inScope) return false;
      if (ALLOWED.has(file)) return false;
      return !ALLOWED_PATTERNS.some((pattern) => pattern.test(file));
    })
    .map((file) => ({
      rule: 'doc-allowlist',
      file,
      detail: 'markdown not on the shippable allowlist (internal doc?) - add to gate6 if it should ship',
    }));
}
