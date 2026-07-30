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
import { ConditionFailedError, type ItemKey } from '@mindlynx/metis-ports';
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
  // The one adapter whose patch reads over a network, so a competing write can
  // genuinely land between its read and its write. SQLite reads synchronously
  // and cannot be interleaved from inside one process; this leg is where the
  // conditional write is exercised for real.
  describe('PostgresAdapter patch under a competing write', () => {
    it('fails instead of overwriting a write that landed inside its read', async () => {
      const adapter = new PostgresAdapter(pgUrl, { schema: `metis_patch_race_${process.pid}` });
      adapter.registerTable({ name: 'races', partitionAttribute: 'PK', sortAttribute: 'SK' });
      await adapter.ready();
      await adapter.put('races', { PK: 'p1', SK: 'META', status: 'running' });

      // Land the competing write in the window patch already has, rather than
      // hoping to win a race: the engine records the real outcome while the
      // reconciler's merge base is still in flight.
      const read = adapter.get.bind(adapter);
      let landed = false;
      adapter.get = async (table: string, key: ItemKey) => {
        const item = await read(table, key);
        if (!landed) {
          landed = true;
          await adapter.put('races', { PK: 'p1', SK: 'META', status: 'failed', why: 'node 3 threw' });
        }
        return item;
      };
      await expect(
        adapter.patch('races', { partitionKey: 'p1', sortKey: 'META' }, { status: 'completed' }),
      ).rejects.toThrow(ConditionFailedError);

      adapter.get = read;
      const item = await adapter.get('races', { partitionKey: 'p1', sortKey: 'META' });
      expect(item?.status).toBe('failed');
      expect(item?.why).toBe('node 3 threw');
      await adapter.dropSchema();
      await adapter.close();
    });
  });

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
