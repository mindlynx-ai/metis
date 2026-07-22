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
import { relative, basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { walkFiles } from './lib/scan.mjs';

export const OPEN_CATEGORIES = new Set(['trigger', 'logic', 'transform', 'integration']);
const CLOSED_TYPE_PREFIXES = ['cortex.', 'skill.', 'approval.', 'tachyon.'];
const FIXTURES_PREFIX = 'gates/fixtures';

function validateEntry(entry, rel, violations) {
  const label = entry.type ?? '(unnamed)';
  if (!OPEN_CATEGORIES.has(entry.category)) {
    violations.push({
      file: rel,
      rule: 'catalogue-closed-category',
      detail: `${label} has category "${entry.category}"`,
    });
  }
  if (entry.tier !== 'open') {
    violations.push({
      file: rel,
      rule: 'catalogue-bad-tier',
      detail: `${label} has tier "${entry.tier}"`,
    });
  }
  if (CLOSED_TYPE_PREFIXES.some((prefix) => String(label).startsWith(prefix))) {
    violations.push({
      file: rel,
      rule: 'catalogue-closed-type',
      detail: `${label} is a closed node type`,
    });
  }
}

export function runCatalogueTierGate(rootDir) {
  const violations = [];
  for (const file of walkFiles(rootDir, [FIXTURES_PREFIX])) {
    if (!/^nodeTypes.*\.json$/.test(basename(file))) continue;
    const rel = relative(rootDir, file);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      violations.push({ file: rel, rule: 'catalogue-unparseable' });
      continue;
    }
    const entries = Array.isArray(parsed) ? parsed : (parsed.entries ?? []);
    for (const entry of entries) {
      validateEntry(entry, rel, violations);
    }
  }
  return violations;
}
