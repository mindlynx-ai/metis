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
 * The editor keeps its own copy of formatOfferPrice: it is a browser bundle
 * and the module-boundary gate stops it importing from metis-ports. A copy is
 * a drift risk, so these cases are deliberately the SAME cases asserted in
 * packages/metis-ports/src/__tests__/uplift-clients.contract.spec.ts. If the
 * two implementations ever disagree, one of the two suites goes red.
 */
import { describe, expect, it } from 'vitest';
import { formatOfferPrice } from '../uplift-api.js';

describe('formatOfferPrice (editor copy, must match the ports definition)', () => {
  it('states a whole amount without trailing zeroes', () => {
    expect(formatOfferPrice({ amount: 900, currency: 'GBP', interval: 'month' })).toBe('£9/month');
  });

  it('keeps the pence when there are pence', () => {
    expect(formatOfferPrice({ amount: 1250, currency: 'GBP', interval: 'month' })).toBe(
      '£12.50/month',
    );
  });

  it('falls back to the ISO code rather than guessing a symbol', () => {
    expect(formatOfferPrice({ amount: 9900, currency: 'ZAR', interval: 'year' })).toBe(
      'ZAR 99/year',
    );
  });
});
