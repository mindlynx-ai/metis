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
 * The one test that crosses the boundary: Metis against a REAL Helix.
 *
 * Everything else in this suite proves Metis against the in-repo stub, and the
 * stub is the contract - but a stub can only ever prove Metis agrees with our
 * OWN idea of the contract. It cannot catch the two sides drifting apart, which
 * is precisely the failure a customer meets on the day they connect.
 *
 * It is not hypothetical. The first run of this file found two:
 *   - helix-core's live manifest carried six capabilities where this build
 *     bundles seven, and the LIVE manifest wins - so "Public webhook address"
 *     VANISHED from the account page the moment an account was connected.
 *   - it carried neither `local` nor `entitledHint`, the two fields that stop
 *     every capability borrowing the data one's "Works here with smaller data."
 *
 * Skipped unless pointed at something. The fast suite must never need a
 * database, a Postgres or anything outside this repo:
 *
 *   METIS_E2E_HELIX_URL=http://127.0.0.1:3002 \
 *   METIS_E2E_HELIX_IDENTITY_URL=http://127.0.0.1:3002/api/identity \
 *   npx playwright test real-helix.spec.ts
 */
import { test, expect } from '@playwright/test';
import { login } from './helpers.js';

const REAL_HELIX = process.env.METIS_E2E_HELIX_URL;

/*
 * A CONDITIONAL skip, not a disabled test: both cases run in full whenever
 * METIS_E2E_HELIX_URL points at a helix-core. Without it there is nothing on
 * the other end to compare against, and the fast suite must never require a
 * service outside this repo.
 */
test.skip(!REAL_HELIX, 'set METIS_E2E_HELIX_URL to run against a real helix-core');

test('the live manifest carries every capability this build bundles', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/account');
  await expect(page.locator('.acct-hero h2')).toBeVisible();

  const cards = page.locator('.capcard');
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });

  // Seven, because STATIC_OFFERS bundles seven. A live manifest with fewer does
  // not fall back - it deletes the card.
  await expect(cards).toHaveCount(7);

  const text = await page.locator('body').innerText();
  for (const title of [
    'Big data',
    'Public webhook address',
    'Memory',
    'Agents',
    'Models',
    'Multi-tenancy',
    'Teams and sign-on',
  ]) {
    expect(text, `"${title}" is missing from the live manifest`).toContain(title);
  }
});

test('the purchasable capability quotes the price Stripe actually charges', async ({ page }) => {
  // The price is never declared in either repo: helix-core reads it off the
  // live Stripe price object that checkout charges, and Metis renders whatever
  // the manifest carries. That is the whole defence against the storefront and
  // the card disagreeing, which is exactly what happened once (Stripe took £29
  // while the page advertised £9).
  await login(page);
  await page.goto('http://127.0.0.1:4180/account');

  const bigData = page.locator('.capcard', { hasText: 'Big data' });
  await expect(bigData).toBeVisible({ timeout: 15_000 });
  await expect(bigData).toContainText('£9/month');

  // And nothing coming-soon quotes a number: only what can be bought has one.
  const soon = page.locator('.capcard', { hasText: 'Public webhook address' });
  await expect(soon).not.toContainText('£');
});

test('each capability states its own local limit, not the data one\'s', async ({ page }) => {
  // The webhook's local limit is REACH; big data's is SIZE. When the live
  // manifest drops `local`, both silently read as "Works here with smaller
  // data." - so this is asserted where a user would see it, on the palette
  // strip, not against an API response that a failed fetch could make vacuous.
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/uplift-webhook/edit');
  await page.getByRole('button', { name: 'Add step' }).click();
  const lib = page.locator('.library');
  await lib.getByLabel('Find a step').fill('webhook');

  const uplift = lib.locator('.lib-uplift').first();
  await expect(uplift.locator('.up-glyph')).toBeVisible();
  await uplift.locator('.lib-item').focus();

  const strip = uplift.locator('.up-strip');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('Works on this computer and this network.');
  await expect(strip).toContainText('Full version in the cloud takes deliveries from anywhere.');
  await expect(strip).not.toContainText('smaller data');
});
