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
import type { DataStore } from '@mindlynx/metis-ports';
import { SqliteAdapter } from './sqlite-adapter.js';
import { PostgresAdapter } from './postgres-adapter.js';

export interface DataStoreEnv {
  METIS_DATASTORE?: string;
  PG_URL?: string;
}

/**
 * Select the DataStore adapter with a single environment variable:
 * the default is SQLite at the given file path;
 * METIS_DATASTORE=postgres switches to Postgres with no other change.
 */
export function createDataStoreFromEnv(env: DataStoreEnv, sqliteFile: string): DataStore {
  const choice = env.METIS_DATASTORE ?? 'sqlite';
  if (choice === 'sqlite') {
    return new SqliteAdapter(sqliteFile);
  }
  if (choice === 'postgres') {
    if (!env.PG_URL) throw new Error('METIS_DATASTORE=postgres requires PG_URL to be set');
    return new PostgresAdapter(env.PG_URL);
  }
  throw new Error(`unknown datastore "${choice}"; expected sqlite or postgres`);
}
