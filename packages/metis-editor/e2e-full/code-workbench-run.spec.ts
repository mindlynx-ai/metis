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
 * Running a step from the workbench, against a REAL engine.
 *
 * Here rather than in the fast suite because that one stubs execution, and a
 * stubbed run cannot produce a JavaScript syntax error - so the line marker,
 * which is the whole point, would have nothing to mark.
 *
 * The line numbers being right is what makes the marker worth having. They used
 * to be two out: the wrapper spliced the source into the middle of line 3, so a
 * mistake on line 1 reported as line 3 column 46.
 */
import { test, expect } from '@playwright/test';
import { addStep, setEditorValue } from '../e2e/helpers.js';

/**
 * This harness seeds `admin`, not the fast suite's `jeremy` - it boots the real
 * runtime, so its users come from seedUsers and the default secret.
 */
const login = async (page: import('@playwright/test').Page) => {
  await page.goto('http://127.0.0.1:4180/login');
  await page.getByLabel('User').fill('admin');
  await page.getByLabel('Password').fill('metis');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
};

const openWorkbench = async (page: import('@playwright/test').Page) => {
  await page.goto('http://127.0.0.1:4180/workflows/new');
  await addStep(page, /Code/);
  await page.locator('.metis-node').first().click();
  await page.getByRole('button', { name: /Open the editor/ }).first().click();
  await expect(page.locator('.modal.modal-wide')).toBeVisible();
};

test('a sample input reaches the code, and the result comes back beside it', async ({ page }) => {
  await login(page);
  await openWorkbench(page);

  await setEditorValue(page, '.modal', 'return { doubled: input.n * 2 };');
  await page.getByLabel('Sample input JSON').fill('{"n": 21}');
  await page.getByRole('button', { name: /Run this step/ }).click();

  await expect(page.locator('.test-output')).toContainText('"doubled": 42', { timeout: 20_000 });
});

test('a failing line is marked in the gutter, and clears when it is edited', async ({ page }) => {
  await login(page);
  await openWorkbench(page);

  // A SYNTAX error, because that is the class that carries a position. The
  // mistake is on line 3, and line 3 is what must light up - it used to be
  // reported as line 5, which is why marking anything was pointless before.
  await setEditorValue(page, '.modal', 'const a = 1;\nconst b = 2;\nreturn a b c;');
  await page.getByRole('button', { name: /Run this step/ }).click();

  const marked = page.locator('.modal .cm-error-line');
  await expect(marked).toBeVisible({ timeout: 20_000 });
  await expect(marked).toHaveText('return a b c;');
  // Visible rather than counted: the editor draws two gutter columns (line
  // numbers and folding) and the marker lands in both, which is right and not
  // worth pinning to a number that changes if a gutter is ever added.
  await expect(page.locator('.modal .cm-error-gutter').first()).toBeVisible();
  await expect(page.locator('.workbench')).toContainText('line 3');

  // Editing clears it: a marker that outlives the mistake is its own kind of lie.
  await page.locator('.modal .cm-content').click();
  await page.keyboard.type(' ');
  await expect(page.locator('.modal .cm-error-line')).toHaveCount(0);
});

