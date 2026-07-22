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
import { runModuleBoundaryGate } from './gate1-module-boundary.mjs';
import { runNoAwsSdkGate } from './gate2-no-aws-sdk.mjs';
import { runCatalogueTierGate } from './gate3-catalogue-tier.mjs';
import { runIdentifierScanGate } from './gate4-identifier-scan.mjs';
import { runStandaloneBootGate } from './gate5-standalone-boot.mjs';
import { runDocAllowlistGate } from './gate6-doc-allowlist.mjs';

const GATES = [
  { id: 1, name: 'module boundary', run: runModuleBoundaryGate },
  { id: 2, name: 'no AWS SDK', run: runNoAwsSdkGate },
  { id: 3, name: 'catalogue tier', run: runCatalogueTierGate },
  { id: 4, name: 'identifier scan', run: runIdentifierScanGate },
  { id: 5, name: 'standalone boot topology', run: runStandaloneBootGate },
  { id: 6, name: 'doc allowlist', run: runDocAllowlistGate },
];

const root = process.cwd();
let failed = false;
for (const gate of GATES) {
  const violations = gate.run(root);
  if (violations.length > 0) {
    failed = true;
    console.error(`gate ${gate.id} (${gate.name}) FAILED:`);
    for (const v of violations) {
      const detail = v.detail ? `: ${v.detail}` : '';
      console.error(`  [${v.rule}] ${v.file}${detail}`);
    }
  } else {
    console.log(`gate ${gate.id} (${gate.name}) passed`);
  }
}
if (failed) process.exit(1);
console.log('all gates passed');
