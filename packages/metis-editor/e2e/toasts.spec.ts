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
 * Toasts: transient, polite feedback for the actions that used to be silent.
 * Saving a workflow announces success; the toast dismisses on its own and by
 * hand; the host is an aria-live status region.
 */
import { test, expect } from '@playwright/test';
import { login, addStep } from './helpers.js';

test('saving a workflow raises a success toast that auto-dismisses', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/toast-check/edit');
  await addStep(page, /HTTP API/);
  await page.getByRole('button', { name: 'Save draft' }).click();

  const host = page.locator('.toasts');
  await expect(host).toHaveAttribute('aria-live', 'polite');
  const toast = page.locator('.toast-success', { hasText: 'Draft saved' });
  await expect(toast).toBeVisible();
  // Auto-dismisses (4s default; Playwright waits).
  await expect(toast).toBeHidden({ timeout: 8000 });
});

test('a toast can be dismissed by hand', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/toast-dismiss/edit');
  await addStep(page, /HTTP API/);
  await page.getByRole('button', { name: 'Save draft' }).click();

  const toast = page.locator('.toast-success', { hasText: 'Draft saved' });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Dismiss' }).click();
  await expect(toast).toBeHidden();
});
