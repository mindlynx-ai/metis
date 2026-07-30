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
// v3 is the scoped one. v2 is unscoped and still installable, and the crypto
// packages are a cloud-vendor dependency by any other name.
const AWS_PACKAGES = [AWS_SCOPE, 'aws-' + 'sdk', '@aws-' + 'crypto/'];
const FIXTURES_PREFIX = 'gates/fixtures';

const isAwsPackage = (spec) =>
  AWS_PACKAGES.some((name) => spec === name || spec.startsWith(name.endsWith('/') ? name : `${name}/`));

export function runNoAwsSdkGate(rootDir) {
  const violations = [];
  for (const file of walkFiles(rootDir, [FIXTURES_PREFIX])) {
    if (!isSourceFile(file)) continue;
    for (const spec of collectImportSpecifiers(file)) {
      if (isAwsPackage(spec)) {
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
    if (AWS_PACKAGES.some((name) => lock.includes(`node_modules/${name}`))) {
      violations.push({
        file: 'package-lock.json',
        rule: 'no-aws-sdk',
        detail: 'an AWS SDK package is present in the dependency tree',
      });
    }
  }
  return violations;
}
