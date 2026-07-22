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
 * The one connect form renders its fields from the connector's auth scheme
 * (the "connection method"). Proves the database method yields the discrete
 * database fields, so Postgres/MySQL/SQL Server all use the same form.
 */
import { describe, it, expect } from 'vitest';
import { fieldsForScheme } from '../connectors/credential-fields.js';

describe('fieldsForScheme (the one form, keyed by connection method)', () => {
  it('database yields host/port/database/user/password', () => {
    expect(fieldsForScheme('database').map((f) => f.key)).toEqual([
      'host',
      'port',
      'database',
      'user',
      'password',
    ]);
    // the password field is masked.
    expect(fieldsForScheme('database').find((f) => f.key === 'password')?.secret).toBe(true);
  });

  it('bearer is a single token; basic is user+password; none needs nothing', () => {
    expect(fieldsForScheme('bearer').map((f) => f.key)).toEqual(['token']);
    expect(fieldsForScheme('basic').map((f) => f.key)).toEqual(['user', 'password']);
    expect(fieldsForScheme('none')).toEqual([]);
  });
});
