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
 * Generate docs/nodes/<type>.md from the catalogue - the single source of
 * truth for the in-app Guide tab and the repo's node reference. Run:
 *   node scripts/generate-node-docs.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The style gate forbids the em dash; palette text may carry it as \u2014.
const clean = (text) => String(text ?? '').replaceAll(String.fromCharCode(0x2014), '-');
const catalogue = JSON.parse(
  readFileSync(join(root, 'packages/metis-catalogue/src/nodeTypes.v1.json'), 'utf8'),
);
const outDir = join(root, 'docs', 'nodes');
mkdirSync(outDir, { recursive: true });
for (const stale of readdirSync(outDir)) {
  if (stale.endsWith('.md')) unlinkSync(join(outDir, stale));
}

const schemaRows = (schema) =>
  Object.entries(schema?.properties ?? {})
    .map(([name, prop]) => {
      const required = (schema.required ?? []).includes(name) ? ' (required)' : '';
      const description = prop.description ? ` - ${clean(prop.description)}` : '';
      return `- \`${name}\`${required}${description}`;
    })
    .join('\n');

const index = [];
for (const entry of catalogue.entries) {
  if (!entry.docs) continue;
  const label = clean(entry.palette?.label ?? entry.type);
  const lines = [
    `# ${label}`,
    '',
    `> ${clean(entry.palette?.description)}`,
    '',
    clean(entry.docs.trim()),
  ];
  const config = schemaRows(entry.configSchema);
  if (config) lines.push('', '## Configuration reference', '', config);
  const output = schemaRows(entry.outputSchema);
  if (output) lines.push('', '## Output fields', '', output);
  lines.push('');
  writeFileSync(join(outDir, `${entry.type}.md`), lines.join('\n'));
  index.push(`- [${label}](${entry.type}.md) - ${clean(entry.palette?.description)}`);
}
writeFileSync(
  join(outDir, 'README.md'),
  `# Node reference\n\nGenerated from the node catalogue - do not edit by hand\n(run \`node scripts/generate-node-docs.mjs\`).\n\n${index.join('\n')}\n`,
);
console.log(`wrote ${index.length} node docs + index to docs/nodes/`);
