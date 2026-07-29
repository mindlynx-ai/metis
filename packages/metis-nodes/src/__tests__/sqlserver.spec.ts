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
 * The parts of the SQL Server adapter that can be proven without a server: the
 * generated dialect, and the row cap it injects. Every case here is one that
 * would be a SILENT WRONG ANSWER rather than an error if it drifted, which is
 * what makes it worth pinning: a TOP in the wrong place returns the wrong rows
 * and returns them successfully.
 */
import { describe, expect, it } from 'vitest';
import { buildQuery, dialectFor, SQLSERVER_DIALECT } from '../postgres-query.js';
import { capAtSource, namedParams, paramDeclaration } from '../sqlserver-data-source.js';

describe('the SQL Server dialect', () => {
  const select = {
    operation: 'select',
    tables: [{ name: 'orders', columns: [{ name: 'customer' }] }],
    where: [{ column: 'status', operator: '=', value: 'paid' }],
  };

  it('brackets identifiers and binds with @p1', () => {
    const built = buildQuery(select, SQLSERVER_DIALECT);
    expect(built.query).toBe(
      'SELECT [orders].[customer] FROM [dbo].[orders] WHERE [orders].[status] = @p1',
    );
    expect(built.params).toEqual(['paid']);
  });

  it('caps with a leading TOP, because SQL Server has no LIMIT', () => {
    // Appending LIMIT would be a parse error; putting TOP after the column list
    // would be another. The cap belongs in front of the columns.
    const built = buildQuery({ ...select, limit: 25 }, SQLSERVER_DIALECT);
    expect(built.query).toContain('SELECT TOP (25) [orders].[customer]');
    expect(built.query).not.toMatch(/LIMIT/i);
  });

  it('keeps TOP behind DISTINCT, which is the only order SQL Server accepts', () => {
    const built = buildQuery(
      { ...select, operation: 'select distinct', limit: 5 },
      SQLSERVER_DIALECT,
    );
    expect(built.query).toContain('SELECT DISTINCT TOP (5) ');
  });

  it('leaves the other dialects capping the way they always did', () => {
    expect(buildQuery({ ...select, limit: 25 }).query).toMatch(/LIMIT 25$/);
    expect(buildQuery({ ...select, limit: 25 }, dialectFor('mysql')).query).toMatch(/LIMIT 25$/);
  });

  it('resolves the engine name to its own dialect', () => {
    expect(dialectFor('sqlserver')).toBe(SQLSERVER_DIALECT);
  });

  it('refuses a builder write rather than emitting Postgres syntax at it', () => {
    // RETURNING and ON CONFLICT are spelt OUTPUT INSERTED.* and MERGE here, and
    // neither is generated, so the builder must say so instead of guessing.
    expect(() =>
      buildQuery({ operation: 'insert', tables: [{ name: 't', values: { a: 1 } }] }, SQLSERVER_DIALECT),
    ).toThrow(/write it as SQL/);
  });

  it('rejects an identifier carrying a closing bracket', () => {
    expect(() =>
      buildQuery({ operation: 'select', tables: [{ name: 'x]; DROP TABLE t;--' }] }, SQLSERVER_DIALECT),
    ).toThrow(/invalid table/);
  });
});

describe('capping a SQL Server read at the source', () => {
  it('injects TOP ahead of the columns, fetching one extra to detect more', () => {
    expect(capAtSource('select customer from orders', 1000)).toBe(
      'select TOP (1001) customer from orders',
    );
    // A trailing semicolon would sit in the middle of nothing here, but it is
    // stripped for the same reason the other adapters strip it.
    expect(capAtSource('select 1;', 10)).toBe('select TOP (11) 1');
  });

  it('goes behind DISTINCT rather than in front of it', () => {
    expect(capAtSource('SELECT DISTINCT status FROM orders', 5)).toBe(
      'SELECT DISTINCT TOP (6) status FROM orders',
    );
  });

  it('keeps an ORDER BY intact, which a wrapping derived table could not', () => {
    // The trap: `SELECT * FROM (select ... order by id) AS _capped` is what the
    // other adapters do and SQL Server rejects it outright. Injecting the cap
    // leaves the ordering where the author put it.
    expect(capAtSource('select customer from orders order by id', 2)).toBe(
      'select TOP (3) customer from orders order by id',
    );
  });

  it('leaves a set operation alone, because TOP would bind to its first half', () => {
    // `SELECT TOP (3) a FROM t UNION ALL SELECT a FROM u` caps the first query
    // and not the union, so it answers a different question successfully. Not
    // capping at the source is the honest option; capRows still guards memory.
    const union = 'select a from t union all select a from u';
    expect(capAtSource(union, 2)).toBe(union);
  });

  it('leaves a query that already caps itself alone', () => {
    // A second TOP is a parse error, and TOP alongside OFFSET/FETCH is refused.
    expect(capAtSource('select top 5 a from t', 100)).toBe('select top 5 a from t');
    const paged = 'select a from t order by a offset 10 rows fetch next 5 rows only';
    expect(capAtSource(paged, 100)).toBe(paged);
  });

  it('leaves a CTE alone rather than injecting into the WITH', () => {
    const cte = 'with q as (select 1 as a) select * from q';
    expect(capAtSource(cte, 10)).toBe(cte);
  });
});

describe('binding parameters the way the driver does', () => {
  it('names positional values p1, p2 ... to match the @p1 the dialect emits', () => {
    // The driver binds by name only. If these two ever disagree, a workflow's
    // parameters silently bind to nothing.
    expect(namedParams(['refunded', 3])).toEqual({ p1: 'refunded', p2: 3 });
    expect(namedParams([])).toEqual({});
  });

  it('declares those parameters for a describe, and nothing when there are none', () => {
    expect(paramDeclaration(2)).toBe('@p1 sql_variant, @p2 sql_variant');
    expect(paramDeclaration(0)).toBeNull();
  });
});
