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
import { httpErrorOf, outputSize } from '../builder/inspector/TestTab.js';

describe('httpErrorOf', () => {
  it('flags a 4xx with the provider message (the Resend unverified-domain case)', () => {
    expect(
      httpErrorOf({
        status: 403,
        ok: false,
        data: { message: 'The idigit.co.uk domain is not verified.' },
      }),
    ).toBe('403 The idigit.co.uk domain is not verified.');
  });

  it('flags ok:false even without a status', () => {
    expect(httpErrorOf({ ok: false, data: { error: 'nope' } })).toBe('nope');
  });

  it('flags a 5xx without a message with a generic reason', () => {
    expect(httpErrorOf({ status: 502, ok: false, data: {} })).toBe('The request returned 502.');
  });

  it('returns undefined for a successful result', () => {
    expect(httpErrorOf({ status: 200, ok: true, data: { id: 'x' } })).toBeUndefined();
    expect(httpErrorOf(undefined)).toBeUndefined();
    expect(httpErrorOf('a string')).toBeUndefined();
  });
});

describe('outputSize', () => {
  it('reports rows + KB for a query result', () => {
    const s = outputSize({ rows: [{ a: 1 }, { a: 2 }], rowCount: 2, truncated: false });
    expect(s?.rows).toBe(2);
    expect(s?.truncated).toBe(false);
    expect(Number(s?.kb)).toBeGreaterThan(0);
  });

  it('flags a truncated result', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ i }));
    const s = outputSize({ rows, rowCount: 1000, truncated: true });
    expect(s?.rows).toBe(1000);
    expect(s?.truncated).toBe(true);
  });

  it('reports bytes-only for a non-row output, and nothing for empty', () => {
    expect(outputSize({ id: 'x' })?.rows).toBeUndefined();
    expect(outputSize(undefined)).toBeUndefined();
  });
});
