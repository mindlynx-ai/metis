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
import { runDataStoreConformance } from '../conformance.js';
import { PostgresAdapter } from '../postgres-adapter.js';

const pgUrl = process.env.PG_URL;

if (!pgUrl) {
  // Local-only convenience: the leg needs a live Postgres. In CI a
  // missing PG_URL must be a hard failure, never a silent skip.
  describe('DataStore conformance: postgres (PG_URL not set)', () => {
    it('is only allowed to stand down outside CI', () => {
      expect(process.env.CI).toBeUndefined();
    });
  });
}

if (pgUrl) {
  let schemaCounter = 0;
  runDataStoreConformance('postgres', async () => {
    schemaCounter += 1;
    const schema = `metis_conformance_${process.pid}_${schemaCounter}`;
    const adapter = new PostgresAdapter(pgUrl, { schema });
    await adapter.ready();
    return {
      adapter,
      teardown: async () => {
        await adapter.dropSchema();
        await adapter.close();
      },
    };
  });
}
