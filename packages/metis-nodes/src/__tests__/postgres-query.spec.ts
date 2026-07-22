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
 * The postgres visual query-builder (Helix parity). DB-free: asserts the
 * generated SQL string + params, and the injection/safety guards.
 */
import { describe, it, expect } from 'vitest';
import { buildQuery } from '../postgres-query.js';

describe('postgres query builder', () => {
  it('builds a SELECT with where, order by and limit (values parameterised)', () => {
    const built = buildQuery({
      operation: 'select',
      schema: 'public',
      tables: [{ name: 'users', columns: [{ name: 'id' }, { name: 'email', alias: 'mail' }] }],
      where: [{ column: 'tier', operator: '=', value: 'gold' }],
      orderBy: [{ column: 'id', direction: 'descending' }],
      limit: 10,
    });
    expect(built.query).toBe(
      'SELECT "users"."id", "users"."email" AS "mail" FROM "public"."users"' +
        ' WHERE "users"."tier" = $1 ORDER BY "users"."id" DESC LIMIT 10',
    );
    expect(built.params).toEqual(['gold']);
  });

  it('builds INSERT ... RETURNING with placeholders', () => {
    const built = buildQuery({
      operation: 'insert',
      tables: [{ name: 'orders', values: { amount: 100, ref: 'A1' } }],
    });
    expect(built.query).toBe(
      'INSERT INTO "public"."orders" ("amount", "ref") VALUES ($1, $2) RETURNING *',
    );
    expect(built.params).toEqual([100, 'A1']);
  });

  it('builds UPDATE with SET then WHERE params in order', () => {
    const built = buildQuery({
      operation: 'update',
      tables: [{ name: 'orders', values: { status: 'paid' } }],
      where: [{ column: 'id', operator: '=', value: 42 }],
    });
    expect(built.query).toBe('UPDATE "public"."orders" SET "status" = $1 WHERE "id" = $2 RETURNING *');
    expect(built.params).toEqual(['paid', 42]);
  });

  it('builds an UPSERT with ON CONFLICT DO UPDATE', () => {
    const built = buildQuery({
      operation: 'upsert',
      tables: [{ name: 'kv', columns: [{ name: 'k', value: 'x' }, { name: 'v', value: 1 }] }],
      conflictColumns: ['k'],
    });
    expect(built.query).toBe(
      'INSERT INTO "public"."kv" ("k", "v") VALUES ($1, $2) ON CONFLICT ("k") DO UPDATE SET "v" = EXCLUDED."v" RETURNING *',
    );
    expect(built.params).toEqual(['x', 1]);
  });

  it('refuses an unbounded UPDATE / DELETE', () => {
    expect(() => buildQuery({ operation: 'update', tables: [{ name: 't', values: { a: 1 } }] })).toThrow(
      /WHERE/,
    );
    expect(() => buildQuery({ operation: 'delete', tables: [{ name: 't' }] })).toThrow(/WHERE/);
  });

  it('rejects an injected identifier and a non-allowlisted operator', () => {
    expect(() =>
      buildQuery({ operation: 'select', tables: [{ name: 'users"; DROP TABLE users;--', columns: [] }] }),
    ).toThrow(/invalid table/);
    expect(() =>
      buildQuery({
        operation: 'select',
        tables: [{ name: 'users', columns: [{ name: 'id' }] }],
        where: [{ column: 'id', operator: '; DROP', value: 1 }],
      }),
    ).toThrow(/not in allowlist/);
  });
});
