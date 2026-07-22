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
 * B2: the overview landing. Live stats, a 14-day activity chart, what needs
 * attention, the busiest workflows and recent runs - all computed on the client
 * from the seeded workflow/execution/connection lists. Counts accrue as other
 * specs run against the shared dev store, so this asserts structure and the
 * always-present seeded failed run, not exact totals.
 */
import { test, expect } from '@playwright/test';
import { login } from './helpers.js';

test('the overview shows live stats, activity and recent runs', async ({ page }) => {
  await login(page);
  const main = page.locator('.ov-page');
  await expect(main).toBeVisible();

  // Four stat cards, each labelled.
  for (const label of ['Active workflows', 'Total runs', 'Success rate', 'Connected tools']) {
    await expect(main.getByText(label, { exact: true })).toBeVisible();
  }

  // The activity chart renders one bar per day of the 14-day window.
  await expect(main.locator('.ov-bar')).toHaveCount(14);

  // The seeded failed run surfaces under "Needs attention" and deep-links.
  const attn = main.locator('.ov-attn');
  await expect(attn).toContainText('Needs attention');
  await attn.getByRole('link', { name: 'Inspect' }).first().click();
  await expect(page).toHaveURL(/\/executions\//);
});

test('the overview links onward to history and busiest workflows', async ({ page }) => {
  await login(page);
  const main = page.locator('.ov-page');
  await expect(main.locator('.ov-recent-list')).toBeVisible();
  await main.getByRole('link', { name: 'View all runs' }).click();
  await expect(page).toHaveURL(/\/operate$/);
});
