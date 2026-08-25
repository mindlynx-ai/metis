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
 * Render the node reference from the catalogue, as filename -> contents.
 *
 * Pure, and separate from the script that writes it, so the GATE can render the
 * same thing and compare without touching the working tree. Two commits shipped
 * with a catalogue edit and a stale `docs/nodes/*.md` beside it because nothing
 * checked; that is what gate 7 is for, and this is the half they share.
 */

// The style gate forbids the em dash; palette text may carry one, so strip it.
const clean = (text) => String(text ?? '').replaceAll(String.fromCharCode(0x2014), '-');

const schemaRows = (schema) =>
  Object.entries(schema?.properties ?? {})
    .map(([name, prop]) => {
      const required = (schema.required ?? []).includes(name) ? ' (required)' : '';
      const description = prop.description ? ` - ${clean(prop.description)}` : '';
      return `- \`${name}\`${required}${description}`;
    })
    .join('\n');

/** @returns {Map<string, string>} filename (within docs/nodes) -> contents */
export function renderNodeDocs(catalogue) {
  const files = new Map();
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
    files.set(`${entry.type}.md`, lines.join('\n'));
    index.push(`- [${label}](${entry.type}.md) - ${clean(entry.palette?.description)}`);
  }
  files.set(
    'README.md',
    `# Node reference\n\nGenerated from the node catalogue - do not edit by hand\n(run \`node scripts/generate-node-docs.mjs\`).\n\n${index.join('\n')}\n`,
  );
  return files;
}
