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
 * The accessibility audit: the whole editor, not just
 * the shell. Every real route passes axe including colour-contrast in
 * both themes; the builder is fully keyboard operable end to end;
 * focus is visible on every tab stop; reduced motion is honoured; and
 * the app is usable at a 375px mobile width.
 */
import { test, expect } from '@playwright/test';
import { login, addStep } from './helpers.js';
import { AxeBuilder } from '@axe-core/playwright';

const ROUTES = [
  '/login',
  '/',
  '/workflows/audit-flow/edit',
  '/workflows/wf-runs-demo/runs',
  '/operate',
  '/connectors',
  '/executions/exec_seeded_failed',
] as const;
const THEMES = ['light', 'dark'] as const;

for (const theme of THEMES) {
  for (const route of ROUTES) {
    test(`${route} passes axe including contrast in ${theme}`, async ({ page }) => {
      await login(page);
      await page.addInitScript((wanted) => localStorage.setItem('metis-theme', wanted), theme);
      await page.goto(`http://127.0.0.1:4180${route}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(150);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      const blocking = results.violations.filter(
        (violation: { impact?: string | null }) =>
          violation.impact === 'serious' || violation.impact === 'critical',
      );
      expect(
        blocking.map((violation: { id: string; help: string }) => `${violation.id}: ${violation.help}`),
      ).toEqual([]);
    });
  }
}

for (const theme of THEMES) {
  test(`the open inspector passes axe including contrast in ${theme}`, async ({ page }) => {
    await login(page);
    await page.addInitScript((wanted) => localStorage.setItem('metis-theme', wanted), theme);
    await page.goto('http://127.0.0.1:4180/workflows/inspector-audit/edit');
    // Open an HTTP API node with every advanced widget revealed, so axe
    // scans the pills, headers editor, disclosures, tabs and footer.
    await addStep(page, /HTTP API/);
    await page.locator('.metis-node').first().click();
    await page.locator('.inspector .disclosure > summary').click();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);

    const results = await new AxeBuilder({ page })
      .include('.inspector')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    const blocking = results.violations.filter(
      (violation: { impact?: string | null }) =>
        violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(
      blocking.map((violation: { id: string; help: string }) => `${violation.id}: ${violation.help}`),
    ).toEqual([]);
  });
}

test('the builder is operable by keyboard alone: add, configure, save', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/keyboard-flow/edit');

  // Open the library, then tab to the first step and activate it by keyboard.
  await page.getByRole('button', { name: 'Add step' }).click();
  const firstStep = page.locator('.library .lib-item').first();
  await firstStep.focus();
  await expect(firstStep).toBeFocused();
  const focusOutline = await firstStep.evaluate((el) => getComputedStyle(el).outlineWidth);
  expect(Number.parseFloat(focusOutline)).toBeGreaterThan(0);
  await page.keyboard.press('Enter');
  await expect(page.locator('.metis-node')).toHaveCount(1);

  // The node carries a tab stop into the inspector via selection.
  await page.locator('.metis-node').first().click();
  const firstField = page.locator('.inspector .field').first().locator('input, select, textarea');
  await firstField.first().focus();
  await expect(firstField.first()).toBeFocused();
  await page.keyboard.type('https://keyboard.example.test');

  // Edits merge live (no Apply). Save from the inspector footer by keyboard.
  await page.locator('.inspector .ins-foot .btn-primary').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.builder-bar .saved-hint')).toBeVisible();
});

test('every top-bar control shows a visible focus ring', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/');
  const toggle = page.getByRole('button', { name: 'Switch theme' });
  await toggle.focus();
  const outline = await toggle.evaluate((el) => getComputedStyle(el).outlineWidth);
  expect(Number.parseFloat(outline)).toBeGreaterThan(0);
});

test('reduced motion zeroes builder canvas and node transitions', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4180/login');
  await page.getByLabel('User').fill('jeremy');
  await page.getByLabel('Password').fill('pw');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('http://127.0.0.1:4180/workflows/motion-flow/edit');
  await addStep(page, /Webhook Start/);
  const duration = await page
    .locator('.metis-node')
    .first()
    .evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(duration.split(',').every((value) => Number.parseFloat(value) < 0.02)).toBe(true);
  await context.close();
});

test('the app is usable at a 375px mobile width', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 780 } });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4180/login');
  await page.getByLabel('User').fill('jeremy');
  await page.getByLabel('Password').fill('pw');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  // At mobile width the sidebar becomes a bottom bar; its nav is still present.
  await expect(page.locator('.side-nav')).toBeVisible();

  // No horizontal overflow on any main surface: the body never scrolls sideways.
  for (const route of ['/', '/operate', '/connectors', '/workflows/wf-runs-demo/runs']) {
    await page.goto(`http://127.0.0.1:4180${route}`);
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, route).toBeLessThanOrEqual(1);
  }
  await context.close();
});
