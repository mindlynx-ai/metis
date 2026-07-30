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
 * file must be on this list; anything else fails the gate. Package READMEs and
 * generated node docs are allowed by pattern.
 *
 * "Tracked" is git's answer, not the filesystem's. The gate used to walk the
 * tree, which got it wrong in both directions: it skipped docs/internal (the
 * exact directory it exists to police, so only .gitignore stood between the
 * build plans and the public repo) and it flagged a maintainer's untracked
 * scratch notes, which cannot ship. Reading the index judges what would
 * actually go out, so the gate fires the moment an internal doc is staged.
 */
import { execFileSync } from 'node:child_process';

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
  'docs/pricing.md',
  'deploy/aws/README.md',
]);

const ALLOWED_PATTERNS = [
  /^packages\/[^/]+\/README\.md$/, // per-package overviews
  /^docs\/nodes\/[^/]+\.md$/, // generated node reference
  /^\.github\//, // issue/PR templates
];

const FIXTURES_PREFIX = 'gates/fixtures';

/** Every markdown file in git's index, relative to rootDir. */
function trackedMarkdown(rootDir) {
  // git's location varies by platform, so PATH resolution is required.
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  const out = execFileSync('git', ['ls-files', '-z', '--', '*.md'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  return out.split('\0').filter(Boolean);
}

export function runDocAllowlistGate(rootDir) {
  let tracked;
  try {
    tracked = trackedMarkdown(rootDir);
  } catch (error) {
    // A gate that cannot look must not report success.
    return [{ rule: 'doc-allowlist', file: '(git)', detail: `cannot list tracked files: ${error.message}` }];
  }
  return tracked
    .filter((file) => !file.startsWith(`${FIXTURES_PREFIX}/`))
    .filter((file) => !ALLOWED.has(file) && !ALLOWED_PATTERNS.some((pattern) => pattern.test(file)))
    .map((file) => ({
      rule: 'doc-allowlist',
      file,
      detail: 'markdown not on the shippable allowlist (internal doc?) - add to gate6 if it should ship',
    }));
}
