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
 * Render the mermaid diagrams embedded in the docs to committed SVGs.
 *
 *   node scripts/render-diagrams.mjs
 *
 * The markdown is the single source: each diagram is a ```mermaid fence
 * preceded by `<!-- render: <name>.svg -->`. GitHub and the docs site draw
 * the fence natively; the SVG is for everywhere that does not (npm's README
 * view, PDFs, an editor preview). Extracting rather than keeping .mmd files
 * beside the docs means the two can never drift apart.
 *
 * mermaid-cli is NOT a dependency of this repo - it drags Puppeteer and a
 * browser download, ~300 MB, for a script run by hand a few times a year.
 * `npx -y` fetches it for the one invocation instead.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs', 'diagrams');
// Which docs are scanned. Add a file here when it grows its first diagram.
const SOURCES = ['docs/architecture.md'];
const BLOCK = /<!--\s*render:\s*([\w.-]+\.svg)\s*-->\s*\n```mermaid\n([\s\S]*?)\n```/g;

const found = [];
for (const source of SOURCES) {
  const text = readFileSync(join(root, source), 'utf8');
  for (const [, name, body] of text.matchAll(BLOCK)) found.push({ source, name, body });
}
if (found.length === 0) {
  console.error(`no "<!-- render: x.svg -->" + mermaid fence pairs found in ${SOURCES.join(', ')}`);
  process.exit(1);
}
const duplicate = found.map((d) => d.name).find((name, i, all) => all.indexOf(name) !== i);
if (duplicate) {
  console.error(`two diagrams both render to ${duplicate} - names must be unique`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const scratch = join(tmpdir(), `metis-diagrams-${process.pid}`);
mkdirSync(scratch, { recursive: true });
// Dark text on a transparent background reads on both docs palettes.
const config = join(scratch, 'config.json');
writeFileSync(config, JSON.stringify({ theme: 'neutral', themeVariables: { fontFamily: 'ui-sans-serif, system-ui, sans-serif' } }));

try {
  for (const { source, name, body } of found) {
    const input = join(scratch, name.replace(/\.svg$/, '.mmd'));
    writeFileSync(input, `${body}\n`);
    // npx resolves from PATH by design - mermaid-cli is deliberately not
    // installed, and this is a maintainer script, never a runtime path.
    execFileSync(
      // eslint-disable-next-line sonarjs/no-os-command-from-path
      'npx',
      ['-y', '@mermaid-js/mermaid-cli', '-i', input, '-o', join(outDir, name), '-c', config, '-b', 'transparent'],
      { cwd: root, stdio: 'inherit' },
    );
    console.log(`${source} -> docs/diagrams/${name}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`rendered ${found.length} diagrams to docs/diagrams/`);
