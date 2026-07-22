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
 * The app-shell design gate: every route renders with
 * the identity live in both themes, axe reports zero serious or
 * critical violations, the theme toggle works and persists, and
 * reduced motion is honoured in the real app.
 */
import { test, expect } from '@playwright/test';
import { login } from './helpers.js';
import { AxeBuilder } from '@axe-core/playwright';

// Authed routes sit behind the RequireAuth guard, so sign in first.
const ROUTES: { path: string; anchor: string }[] = [
  { path: '/', anchor: 'h1.page-title' },
  { path: '/workflows/sample/edit', anchor: '.builder-bar' },
  { path: '/workflows/sample/runs', anchor: '.runs h1' },
];
const THEMES = ['light', 'dark'] as const;

for (const theme of THEMES) {
  for (const route of ROUTES) {
    test(`route ${route.path} passes axe in ${theme}`, async ({ page }) => {
      await login(page);
      await page.addInitScript((wanted) => {
        localStorage.setItem('metis-theme', wanted);
      }, theme);
      await page.goto(`http://127.0.0.1:4180${route.path}`);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator(route.anchor)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);

      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations.filter(
        (violation: { impact?: string | null }) =>
          violation.impact === 'serious' || violation.impact === 'critical',
      );
      expect(
        serious.map((violation: { id: string; help: string }) => `${violation.id}: ${violation.help}`),
      ).toEqual([]);
    });
  }
}

test('the theme toggle switches and persists', async ({ page }) => {
  // The toggle lives in the authed sidebar, so sign in first.
  await login(page);
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  const after = before === 'light' ? 'dark' : 'light';
  await page.getByRole('button', { name: 'Switch theme' }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(after);
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(after);
});

test('reduced motion zeroes shell transitions', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await login(page);
  const duration = await page.evaluate(() => {
    const probe = document.querySelector('.nav-item');
    return probe ? getComputedStyle(probe).transitionDuration : '';
  });
  expect(duration.split(',').every((value) => Number.parseFloat(value) < 0.02)).toBe(true);
  await context.close();
});

test('the builder shell is reachable from the workflows home', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/');
  await page.getByRole('link', { name: 'New workflow' }).click();
  await expect(page).toHaveURL(/workflows\/new/);
  // The builder offers "Add step", which opens the floating node library.
  await page.getByRole('button', { name: 'Add step' }).click();
  await expect(page.locator('.library h2')).toHaveText('Add a step');
});

for (const theme of ['light', 'dark'] as const) {
  test(`login holds the identity in ${theme}`, async ({ page }) => {
    await page.addInitScript((wanted) => localStorage.setItem('metis-theme', wanted), theme);
    await page.goto('http://127.0.0.1:4180/login');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    await expect(page.locator('.login-wordmark')).toBeVisible();
    // Baselines are recorded on macOS (the design workstation).
    if (process.platform === 'darwin') {
      await expect(page).toHaveScreenshot(`login-${theme}.png`, { fullPage: false });
    }
  });
}
