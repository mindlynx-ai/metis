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
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

export const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.metis', 'test-results', 'playwright-report']);
export const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

const IMPORT_PATTERNS = [
  /import\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
  /import\s*['"]([^'"]+)['"]/g,
  /export\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Walk a tree yielding absolute file paths, skipping build output and,
 * optionally, any relative path that starts with one of excludePrefixes.
 */
export function* walkFiles(rootDir, excludePrefixes = []) {
  function* inner(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(rootDir, full);
      if (excludePrefixes.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) {
        continue;
      }
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(entry)) yield* inner(full);
      } else {
        yield full;
      }
    }
  }
  yield* inner(rootDir);
}

/** Collect every import specifier in a source file. */
export function collectImportSpecifiers(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const specifiers = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/** Map package directory name to its manifest for every package in a tree. */
export function readPackageManifests(rootDir) {
  const packagesDir = join(rootDir, 'packages');
  const manifests = new Map();
  if (!existsSync(packagesDir)) return manifests;
  for (const entry of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, entry, 'package.json');
    if (!existsSync(manifestPath)) continue;
    manifests.set(entry, JSON.parse(readFileSync(manifestPath, 'utf8')));
  }
  return manifests;
}

export function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.has(extname(filePath));
}
