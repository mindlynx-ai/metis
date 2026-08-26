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
 * "Connect your Helix account", against a REAL Helix.
 *
 * uplift.spec.ts proves this round trip against the in-repo stub, which
 * auto-approves. This one drives the actual authorization server: a real
 * sign-in page, a real `metis` client row, a real code, a real token.
 *
 * Needs a helix-core AND the Helix UI that serves its login page:
 *
 *   METIS_E2E_HELIX_URL=http://localhost:3002 \
 *   METIS_E2E_HELIX_IDENTITY_URL=http://localhost:3002/api/identity \
 *   METIS_E2E_HELIX_CLIENT_ID=metis \
 *   METIS_E2E_HELIX_EMAIL=… METIS_E2E_HELIX_PASSWORD=… \
 *   npx playwright test real-helix-connect.spec.ts
 */
import { test, expect } from '@playwright/test';
import { login } from './helpers.js';

const REAL_HELIX = process.env.METIS_E2E_HELIX_URL;
const EMAIL = process.env.METIS_E2E_HELIX_EMAIL;
const PASSWORD = process.env.METIS_E2E_HELIX_PASSWORD;

/*
 * A CONDITIONAL skip, not a disabled test: it runs in full whenever a real
 * Helix and a sign-in are supplied. Without them there is no authorization
 * server to talk to, and the fast suite must never require one.
 */
test.skip(
  !REAL_HELIX || !EMAIL || !PASSWORD,
  'set METIS_E2E_HELIX_URL + METIS_E2E_HELIX_EMAIL/PASSWORD to run against a real Helix',
);

test('the account link survives a real authorization server', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/account');

  const connect = page.getByRole('button', { name: 'Connect your Helix account' });
  await expect(connect).toBeVisible();
  await connect.click();

  // The real sign-in page, served by the Helix UI the provider points at.
  const email = page.locator('input[type="email"], input[name="email"]').first();
  await expect(email).toBeVisible({ timeout: 30_000 });
  // The page hydrates after SSR; filling before that leaves React holding an
  // empty form and the click submits nothing.
  await page.waitForLoadState('networkidle');
  await email.fill(String(EMAIL));
  await expect(email).toHaveValue(String(EMAIL));
  const pw = page.locator('input[type="password"]').first();
  await pw.fill(String(PASSWORD));
  await expect(pw).toHaveValue(String(PASSWORD));
  // By name, not by type: the Google button above it is also a submit.
  await page.getByRole('button', { name: /^Sign in$/ }).click();

  // Back on Metis, linked. `metis` is a seeded skipConsent client, so no
  // consent screen stands in the way - that surface is for every OTHER client.
  await expect(page).toHaveURL(/\/account\?connected=1/, { timeout: 45_000 });

  // The hero flips from "Do more with Helix Cloud" + Connect to the linked
  // state. Disconnect existing IS the link existing.
  const hero = page.locator('.acct-hero');
  await expect(hero).toContainText('Helix account', { timeout: 20_000 });
  await expect(hero.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  await expect(hero.getByRole('button', { name: 'Connect your Helix account' })).toHaveCount(0);
});
