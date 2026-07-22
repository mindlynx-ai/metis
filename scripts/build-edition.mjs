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
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDITIONS = ['open', 'helix'];

/**
 * Resolve the package directories included in a given edition.
 * An "open" package is in every edition; a "helix" package is only in
 * the helix edition. The edition marker is the `metis.edition` field of
 * each package manifest, so flipping editions never requires a source
 * edit.
 */
export function resolveEditionPackages(rootDir, edition) {
  if (!EDITIONS.includes(edition)) {
    throw new Error(`unknown edition "${edition}"; expected one of ${EDITIONS.join(', ')}`);
  }
  const packagesDir = join(rootDir, 'packages');
  const included = [];
  for (const entry of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, entry, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const packageEdition = manifest.metis?.edition;
    if (!EDITIONS.includes(packageEdition)) {
      throw new Error(`package ${entry} has no valid metis.edition marker`);
    }
    if (packageEdition === 'open' || packageEdition === edition) {
      included.push(entry);
    }
  }
  return included.sort();
}

/**
 * Order package directories so that workspace dependencies build before
 * their dependants (declaration output must exist for downstream tsc).
 */
export function orderByDependencies(rootDir, entries) {
  const manifestOf = (entry) =>
    JSON.parse(readFileSync(join(rootDir, 'packages', entry, 'package.json'), 'utf8'));
  const nameToEntry = new Map(entries.map((entry) => [manifestOf(entry).name, entry]));
  const ordered = [];
  const visiting = new Set();
  const visit = (entry) => {
    if (ordered.includes(entry)) return;
    if (visiting.has(entry)) throw new Error(`dependency cycle involving ${entry}`);
    visiting.add(entry);
    const manifest = manifestOf(entry);
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      const local = nameToEntry.get(dep);
      if (local) visit(local);
    }
    visiting.delete(entry);
    ordered.push(entry);
  };
  for (const entry of entries) visit(entry);
  return ordered;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const edition = process.env.METIS_EDITION ?? 'open';
  const included = resolveEditionPackages(root, edition);
  const all = readdirSync(join(root, 'packages')).filter((entry) =>
    existsSync(join(root, 'packages', entry, 'package.json')),
  );

  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error('run this script through npm (npm run build) so the npm CLI path is known');
  }

  for (const entry of all) {
    rmSync(join(root, 'packages', entry, 'dist'), { recursive: true, force: true });
  }
  for (const entry of orderByDependencies(root, included)) {
    execFileSync(
      process.execPath,
      [npmCli, 'run', 'build', '--workspace', `packages/${entry}`, '--if-present'],
      {
        cwd: root,
        stdio: 'inherit',
      },
    );
  }
  const excluded = all.filter((entry) => !included.includes(entry));
  console.log(
    `Built the ${edition} edition: ${included.length} packages included` +
      (excluded.length > 0 ? `, ${excluded.length} excluded (${excluded.join(', ')})` : ''),
  );
}
