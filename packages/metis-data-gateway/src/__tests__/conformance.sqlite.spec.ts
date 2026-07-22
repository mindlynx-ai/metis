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
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDataStoreConformance } from '../conformance.js';
import { SqliteAdapter } from '../sqlite-adapter.js';

runDataStoreConformance('sqlite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metis-sqlite-'));
  const adapter = new SqliteAdapter(join(dir, 'test.db'));
  return { adapter, teardown: () => adapter.close() };
});

describe('SqliteAdapter file placement', () => {
  it('creates the database file and its parent directories on open', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'metis-project-'));
    const adapter = new SqliteAdapter(join(projectDir, '.metis', 'metis.db'));
    adapter.registerTable({ name: 'anything', partitionAttribute: 'PK' });
    expect(existsSync(join(projectDir, '.metis', 'metis.db'))).toBe(true);
    adapter.close();
  });
});
