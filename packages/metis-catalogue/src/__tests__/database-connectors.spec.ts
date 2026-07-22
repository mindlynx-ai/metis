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
 * Database connectors live beside the frozen top-100, and the served list is
 * the union of the two. The top-100 stays exactly 100 (its own spec proves the
 * freeze); this proves the database set merges in without disturbing it.
 */
import { describe, it, expect } from 'vitest';
import { getConnectorCatalogue, listAllConnectors } from '../loader.js';
import { DATABASE_CONNECTORS } from '../database-connectors.js';
import { EXTRA_CONNECTORS } from '../extra-connectors.js';

describe('database connectors', () => {
  it('are all on the database auth scheme with a postgres among them', () => {
    expect(DATABASE_CONNECTORS.every((c) => c.authScheme === 'database')).toBe(true);
    expect(DATABASE_CONNECTORS.map((c) => c.connectorId)).toContain('postgres');
  });

  it('merge into the served list without touching the frozen top-100', () => {
    const top100 = getConnectorCatalogue().connectors;
    const all = listAllConnectors();
    expect(top100).toHaveLength(100);
    expect(all).toHaveLength(100 + EXTRA_CONNECTORS.length + DATABASE_CONNECTORS.length);
    expect(all.map((c) => c.connectorId)).toContain('postgres');
    // ids stay unique across the union.
    expect(new Set(all.map((c) => c.connectorId)).size).toBe(all.length);
  });
});
