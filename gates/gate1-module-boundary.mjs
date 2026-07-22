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
import { join, relative, resolve, dirname } from 'node:path';
import {
  walkFiles,
  collectImportSpecifiers,
  readPackageManifests,
  isSourceFile,
} from './lib/scan.mjs';

/**
 * Module-name patterns that must never be imported by an open
 * package: memory, analytics, command layer, agent runtime, governance.
 */
const BANNED_MODULE_PATTERNS = [
  { name: 'cortex', pattern: /cortex/i },
  { name: 'tachyon', pattern: /tachyon/i },
  { name: 'ucl', pattern: /(^|[/-])ucl($|[/-])/i },
  { name: 'skills-runtime', pattern: /skills?[/-](sdk|runtime)/i },
  { name: 'approval', pattern: /approval/i },
  { name: 'agents', pattern: /(^|[/-])agents?($|[/-])/i },
];

function partitionPackages(rootDir) {
  const manifests = readPackageManifests(rootDir);
  const openDirs = [];
  const gatedNames = new Set();
  const gatedRoots = [];
  for (const [dir, manifest] of manifests) {
    if (manifest.metis?.edition === 'open') {
      openDirs.push(dir);
    } else {
      gatedRoots.push(join(rootDir, 'packages', dir));
      if (manifest.name) gatedNames.add(manifest.name);
    }
  }
  return { openDirs, gatedNames, gatedRoots };
}

function bannedPatternFor(spec) {
  return BANNED_MODULE_PATTERNS.find((banned) => banned.pattern.test(spec));
}

function importsGatedName(spec, gatedNames) {
  if (gatedNames.has(spec)) return true;
  return [...gatedNames].some((name) => spec.startsWith(`${name}/`));
}

function resolvesIntoGatedRoot(file, spec, gatedRoots) {
  if (!spec.startsWith('.')) return false;
  const resolved = resolve(dirname(file), spec);
  return gatedRoots.some((root) => resolved === root || resolved.startsWith(`${root}/`));
}

function checkSpecifier(spec, file, rootDir, context, violations) {
  const banned = bannedPatternFor(spec);
  if (banned) {
    violations.push({
      file: relative(rootDir, file),
      rule: 'banned-module-import',
      detail: `imports "${spec}" (${banned.name})`,
    });
  }
  if (importsGatedName(spec, context.gatedNames) || resolvesIntoGatedRoot(file, spec, context.gatedRoots)) {
    violations.push({
      file: relative(rootDir, file),
      rule: 'open-imports-gated-package',
      detail: `imports gated package via "${spec}"`,
    });
  }
}

export function runModuleBoundaryGate(rootDir) {
  const violations = [];
  const context = partitionPackages(rootDir);
  for (const openDir of context.openDirs) {
    const packageRoot = join(rootDir, 'packages', openDir);
    for (const file of walkFiles(packageRoot)) {
      if (!isSourceFile(file)) continue;
      for (const spec of collectImportSpecifiers(file)) {
        checkSpecifier(spec, file, rootDir, context, violations);
      }
    }
  }
  return violations;
}
