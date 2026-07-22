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
 * The release audit: run the whole gate set, the header and style
 * checks, typecheck and tests. Exits non-zero on any finding so a
 * release build cannot go out dirty. String-level IP sweeps live in
 * the gates (gate 2 covers the AWS SDK, gate 4 the banned identifiers).
 */
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const npmCli = process.env.npm_execpath;

function step(name, run) {
  process.stdout.write(`\n=== ${name} ===\n`);
  run();
  process.stdout.write(`ok: ${name}\n`);
}

const npmRun = (script) =>
  execFileSync(process.execPath, [npmCli, 'run', script], { cwd: root, stdio: 'inherit' });

try {
  step('gates', () => npmRun('gates'));
  step('headers', () => npmRun('check:headers'));
  step('lint', () => npmRun('lint'));
  step('typecheck', () => npmRun('typecheck'));
  step('tests', () => npmRun('test'));
  process.stdout.write('\nRelease audit passed: the tree is clean.\n');
} catch (error) {
  process.stderr.write(`\nRelease audit FAILED: ${error.message}\n`);
  process.exit(1);
}
