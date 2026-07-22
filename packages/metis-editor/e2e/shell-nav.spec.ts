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
 * B1: the sidebar shell. The four app surfaces are reachable from the sidebar,
 * the active item reflects the route, and at mobile width the sidebar becomes a
 * bottom bar (brand hidden, nav still present). The builder and login render
 * outside the shell (no sidebar).
 */
import { test, expect } from '@playwright/test';
import { login } from './helpers.js';

test('the browser tab uses the Metis mark, not a default favicon', async ({ page }) => {
  await page.goto('http://127.0.0.1:4180/login');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.svg');
  const res = await page.request.get('http://127.0.0.1:4180/favicon.svg');
  expect(res.ok()).toBeTruthy();
  expect(res.headers()['content-type']).toContain('svg');
});

test('the sidebar navigates the app surfaces and marks the active one', async ({ page }) => {
  await login(page);
  const sidebar = page.locator('.sidebar');
  await expect(sidebar).toBeVisible();

  // Overview is home; its nav item is active on landing.
  await expect(page.locator('.nav-item.on')).toHaveText(/Overview/);

  for (const [label, path, anchor] of [
    ['Workflows', '/workflows', 'h1.page-title'],
    ['Connectors', '/connectors', '.conn-page, .connectors-page, main'],
    ['Operate', '/operate', '.operate-page'],
  ] as const) {
    await sidebar.getByRole('link', { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.locator('.nav-item.on')).toHaveText(new RegExp(label));
    await expect(page.locator(anchor).first()).toBeVisible();
  }

  // Back to Overview.
  await sidebar.getByRole('link', { name: 'Overview' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.ov-page')).toBeVisible();
});

test('the builder renders full-screen without the sidebar', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/nav-check/edit');
  await expect(page.locator('.sidebar')).toHaveCount(0);
});

test('the builder back arrow returns to the workflows list', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/back-nav/edit');
  await page.getByRole('link', { name: 'Back to workflows' }).click();
  await expect(page).toHaveURL(/\/workflows$/);
  await expect(page.locator('h1.page-title')).toHaveText('Workflows');
});

test('the sidebar becomes a bottom bar at mobile width', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 780 } });
  const page = await context.newPage();
  await login(page);
  // Brand hides, but the nav is still reachable as a bottom bar.
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.brand')).toBeHidden();
  await expect(page.locator('.side-nav')).toBeVisible();
  await page.locator('.side-nav').getByRole('link', { name: 'Operate' }).click();
  await expect(page).toHaveURL(/\/operate$/);
  await context.close();
});
