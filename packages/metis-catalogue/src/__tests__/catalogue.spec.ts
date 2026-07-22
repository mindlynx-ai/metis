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
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import {
  getCatalogue,
  getEntry,
  OPEN_CATEGORIES,
  CLOSED_TYPE_PREFIXES,
  type Catalogue,
  type CatalogueEntry,
} from '../index.js';

/**
 * Validate a catalogue: open categories only, tier open, no closed
 * type prefixes, alias targets present, and compilable JSON Schemas on
 * every ready non-alias entry. Test-only: shipped catalogues are locked
 * by this suite, so the runtime never re-validates its own vendored JSON.
 */
function validateCatalogue(catalogue: Catalogue): string[] {
  const ajv = new Ajv({ strict: false });
  const types = new Set(catalogue.entries.map((entry) => entry.type));
  return catalogue.entries.flatMap((entry) => entryProblems(entry, types, ajv));
}

function entryProblems(entry: CatalogueEntry, types: Set<string>, ajv: Ajv): string[] {
  const problems: string[] = [];
  const label = entry.type || '(unnamed)';
  if (!OPEN_CATEGORIES.has(entry.category)) {
    problems.push(`${label}: category "${entry.category}" is not an open category`);
  }
  if (entry.tier !== 'open') {
    problems.push(`${label}: tier "${entry.tier}" is not open`);
  }
  if (CLOSED_TYPE_PREFIXES.some((prefix) => label.startsWith(prefix))) {
    problems.push(`${label}: closed node type`);
  }
  if (entry.alias_of && !types.has(entry.alias_of)) {
    problems.push(`${label}: alias target "${entry.alias_of}" is missing`);
  }
  problems.push(...entrySchemaProblems(entry, ajv));
  return problems;
}

function entrySchemaProblems(entry: CatalogueEntry, ajv: Ajv): string[] {
  if (entry.alias_of || entry.handler_status !== 'ready') return [];
  const problems: string[] = [];
  const schemas: [string, Record<string, unknown> | undefined][] = [
    ['configSchema', entry.configSchema],
    ['outputSchema', entry.outputSchema],
  ];
  for (const [name, schema] of schemas) {
    if (!schema) continue;
    try {
      ajv.compile(schema);
    } catch (error) {
      problems.push(
        `${entry.type}: ${name} does not compile (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return problems;
}

describe('the open node catalogue', () => {
  const catalogue = getCatalogue({ reload: true });

  it('contains only open categories with tier open on every entry', () => {
    expect(catalogue.entries.length).toBeGreaterThanOrEqual(14);
    for (const entry of catalogue.entries) {
      expect(OPEN_CATEGORIES.has(entry.category)).toBe(true);
      expect(entry.tier).toBe('open');
    }
  });

  it('never contains closed node types', () => {
    for (const entry of catalogue.entries) {
      expect(entry.type).not.toMatch(/^(cortex|skill|approval|tachyon)\./);
    }
  });

  it('ships the shipped handler set and the config-only trigger nodes', () => {
    const types = catalogue.entries.map((entry) => entry.type);
    for (const expected of [
      'apiconfig',
      'apiend',
      'webhookconfig',
      'scheduleconfig',
      'signal',
      'switch',
      'waituntil',
      'code',
      'api',
      'postgres',
      'sendgrid',
      'connector',
    ]) {
      expect(types).toContain(expected);
    }
  });

  it('declares a compilable config schema for every ready non-alias entry', () => {
    const problems = validateCatalogue(catalogue);
    expect(problems).toEqual([]);
  });

  it('resolves aliases to their canonical entries', () => {
    expect(getEntry(catalogue, 'http')?.type).toBe('api');
    expect(getEntry(catalogue, 'transform')?.type).toBe('code');
    expect(getEntry(catalogue, 'switch')?.type).toBe('switch');
    expect(getEntry(catalogue, 'cortex.memory.read')).toBeUndefined();
  });

  it('loads an alternate file via an explicit path and reports its violations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-cat-'));
    const path = join(dir, 'nodeTypes.bad.json');
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: '1.0.0',
        entries: [{ type: 'cortex.memory.read', category: 'cortex', tier: 'paid' }],
      }),
    );
    const alternate = getCatalogue({ path, reload: true });
    const problems = validateCatalogue(alternate);
    expect(problems.join(' ')).toMatch(/category/);
    expect(problems.join(' ')).toMatch(/tier/);
    getCatalogue({ reload: true });
  });
});
