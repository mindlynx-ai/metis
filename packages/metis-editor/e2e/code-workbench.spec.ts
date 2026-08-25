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
 * Writing a step in the workbench: the editor, the layout, the way out.
 *
 * The two tests that RUN code live in e2e-full instead, because this harness
 * stubs execution - a stubbed run cannot produce a JavaScript syntax error, so
 * asserting a marked line here would prove nothing.
 *
 * Driven in a browser because none of it can be unit-tested: CodeMirror needs a
 * DOM and this repository's unit suite ships none. The pure parts that CAN be
 * tested without one - which grammar a field gets, which line an error blames,
 * who owns the insert handle - have their own specs.
 */
import { test, expect } from '@playwright/test';
import { login, addStep } from './helpers.js';

const openWorkbench = async (page: import('@playwright/test').Page) => {
  await page.goto('http://127.0.0.1:4180/workflows/new');
  await addStep(page, /Code/);
  await page.locator('.metis-node').first().click();
  await page.getByRole('button', { name: /Open the editor/ }).first().click();
  await expect(page.locator('.modal.modal-wide')).toBeVisible();
};

test('the editor replaces the textarea and shows line numbers', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/new');
  await addStep(page, /Code/);
  await page.locator('.metis-node').first().click();

  const field = page.locator('[data-field="code"]');
  await expect(field.locator('.cm-content')).toBeVisible();
  await expect(field.locator('.cm-gutters')).toBeVisible();
  // The thing it replaced must be gone, or both would be editing the same value.
  await expect(field.locator('textarea')).toHaveCount(0);
});

test('the workbench holds what it receives, the code, a run and what it passes on', async ({
  page,
}) => {
  await login(page);
  await openWorkbench(page);

  const regions = await page
    .locator('.workbench section')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  expect(regions).toEqual([
    'What this step receives',
    'The code',
    'Test this step',
    'What this step passes on',
  ]);
});

test('Escape closes the workbench and hands focus back', async ({ page }) => {
  await login(page);
  await openWorkbench(page);

  await page.keyboard.press('Escape');
  await expect(page.locator('.modal.modal-wide')).toHaveCount(0);
  // Back on the button that opened it, not lost at the top of the document.
  await expect(page.getByRole('button', { name: /Open the editor/ }).first()).toBeFocused();
});

test('a code step points at the workbench instead of a second place to test', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/new');
  await addStep(page, /Code/);
  await page.locator('.metis-node').first().click();
  await page.getByRole('tab', { name: 'Test' }).click();

  // Two sample inputs for one step would drift, and whichever you edited last
  // is the one you remember.
  await expect(page.locator('.test-tab')).toContainText('written and run in the editor');
  await expect(page.getByLabel('Sample input JSON')).toHaveCount(0);
});
