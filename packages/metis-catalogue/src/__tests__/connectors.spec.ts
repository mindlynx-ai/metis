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
import { getConnectorCatalogue } from '../loader.js';
import { generateConnectors } from '../generate-connectors.js';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

describe('connector catalogue (connectors.v1.json)', () => {
  it('holds the frozen top-100 with unique ids', () => {
    const catalogue = getConnectorCatalogue();
    expect(catalogue.count).toBe(100);
    expect(catalogue.connectors).toHaveLength(100);
    const ids = new Set(catalogue.connectors.map((c) => c.connectorId));
    expect(ids.size).toBe(100);
  });

  it('every record is structurally sound (base URL, tier, operations)', () => {
    for (const record of getConnectorCatalogue().connectors) {
      expect(record.baseUrl).toMatch(/^https?:\/\//);
      expect(['open', 'premium']).toContain(record.tier);
      for (const op of record.operations ?? []) {
        expect(HTTP_METHODS.has(op.method)).toBe(true);
        expect(op.pathTemplate.startsWith('/')).toBe(true);
        expect(op.wireStatus).toBe('verified');
      }
    }
  });

  it('ships a wired core and a marked premium set', () => {
    const catalogue = getConnectorCatalogue();
    const wired = catalogue.connectors.filter((c) => (c.operations?.length ?? 0) > 0);
    const premium = catalogue.connectors.filter((c) => c.tier === 'premium');
    expect(wired.length).toBeGreaterThanOrEqual(25);
    expect(premium.length).toBeGreaterThan(0);
    expect(wired.map((c) => c.connectorId)).toContain('slack');
    expect(premium.map((c) => c.connectorId)).toContain('salesforce');
  });

  it('carries webhook and poll trigger events on the wired connectors', () => {
    const catalogue = getConnectorCatalogue();
    const github = catalogue.connectors.find((c) => c.connectorId === 'github');
    expect(github?.events?.some((e) => e.name === 'push' && e.kind === 'webhook')).toBe(true);
    const hubspot = catalogue.connectors.find((c) => c.connectorId === 'hubspot');
    const poll = hubspot?.events?.find((e) => e.kind === 'poll');
    expect(poll?.pollConfig?.cursorField).toBe('createdAt');
  });

  it('the committed artefact matches what the generator would emit (no drift)', () => {
    const regenerated = generateConnectors();
    expect(regenerated).toEqual(getConnectorCatalogue());
  });
});
