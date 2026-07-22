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
 * The picker's featured "suggested" steps: an empty canvas is nudged to start
 * with a trigger (so the workflow can run/publish), and adding after a step
 * follows from what that step is.
 */
import { test, expect } from '@playwright/test';
import { login, addStep } from './helpers.js';

test('an empty canvas is nudged to start with a trigger', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/suggest-empty/edit');
  await page.getByRole('button', { name: 'Add step' }).click();
  const suggested = page.locator('.library .lib-suggested');
  await expect(suggested.locator('.group-label')).toHaveText(/Start with a trigger/);
  await expect(suggested.getByRole('button', { name: /Webhook Start/ })).toBeVisible();
});

test('adding after a trigger suggests a next step (not another trigger)', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/suggest-next/edit');
  await addStep(page, /Webhook Start/);

  // Open the library from the trigger's "+": suggestions follow from the trigger.
  await page.locator('.metis-node').first().hover();
  await page.locator('.fnode-plus').click();
  const suggested = page.locator('.library .lib-suggested');
  await expect(suggested.locator('.group-label')).toHaveText(/Suggested next/);
  await expect(suggested.getByRole('button', { name: /^Code/ })).toBeVisible();
  await expect(suggested.getByRole('button', { name: /Webhook Start/ })).toHaveCount(0);
});
