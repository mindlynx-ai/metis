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
import { join, relative } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { walkFiles, collectImportSpecifiers, isSourceFile } from './lib/scan.mjs';

const AWS_SCOPE = '@aws-' + 'sdk/';
const FIXTURES_PREFIX = 'gates/fixtures';

export function runNoAwsSdkGate(rootDir) {
  const violations = [];
  for (const file of walkFiles(rootDir, [FIXTURES_PREFIX])) {
    if (!isSourceFile(file)) continue;
    for (const spec of collectImportSpecifiers(file)) {
      if (spec.startsWith(AWS_SCOPE)) {
        violations.push({
          file: relative(rootDir, file),
          rule: 'no-aws-sdk',
          detail: `imports "${spec}"`,
        });
      }
    }
  }
  const lockPath = join(rootDir, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lock = readFileSync(lockPath, 'utf8');
    if (lock.includes(`node_modules/${AWS_SCOPE}`)) {
      violations.push({
        file: 'package-lock.json',
        rule: 'no-aws-sdk',
        detail: 'an AWS SDK package is present in the dependency tree',
      });
    }
  }
  return violations;
}
