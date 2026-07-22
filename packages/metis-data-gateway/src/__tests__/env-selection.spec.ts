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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDataStoreFromEnv } from '../env.js';
import { SqliteAdapter } from '../sqlite-adapter.js';
import { PostgresAdapter } from '../postgres-adapter.js';

describe('adapter selection by a single environment variable', () => {
  it('defaults to SQLite at the given file path', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'metis-env-'));
    const adapter = createDataStoreFromEnv({}, join(projectDir, '.metis', 'metis.db'));
    expect(adapter).toBeInstanceOf(SqliteAdapter);
    (adapter as SqliteAdapter).close();
  });

  it('selects Postgres when METIS_DATASTORE=postgres, with no other change', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'metis-env-'));
    const adapter = createDataStoreFromEnv(
      { METIS_DATASTORE: 'postgres', PG_URL: 'postgres://user:pw@localhost:5433/db' },
      join(projectDir, '.metis', 'metis.db'),
    );
    expect(adapter).toBeInstanceOf(PostgresAdapter);
    await (adapter as PostgresAdapter).close();
  });

  it('rejects postgres selection without a connection string', () => {
    expect(() => createDataStoreFromEnv({ METIS_DATASTORE: 'postgres' }, 'x.db')).toThrow(/PG_URL/);
  });

  it('rejects unknown datastore names', () => {
    expect(() => createDataStoreFromEnv({ METIS_DATASTORE: 'dynamodb' }, 'x.db')).toThrow(/unknown/i);
  });
});
