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

test('a syntax error is underlined on the line that has it, and Validate agrees', async ({
  page,
}) => {
  await login(page);
  await openWorkbench(page);

  // The mistake is on line 3. It used to be reported as line 5, which is why
  // underlining anything would have been pointless before.
  await setEditorValue(page, '.modal', 'const a = 1;\nconst b = 2;\nreturn a b c;');

  // Live, without pressing anything: the check is debounced and comes from the
  // real engine, not a parser in the browser.
  await expect(page.locator('.modal .squiggly-error').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.check-bad')).toContainText('Line 3', { timeout: 20_000 });

  // The marker is on the third line, not merely somewhere.
  const markedLine = await page.locator('.modal .monaco-editor').evaluate((element) => {
    const squiggle = element.querySelector('.squiggly-error') as HTMLElement | null;
    if (!squiggle) return -1;
    const top = Number.parseInt(squiggle.parentElement?.style.top ?? '-1', 10);
    const lines = Array.from(element.querySelectorAll<HTMLElement>('.view-line'));
    const match = lines.find((line) => Number.parseInt(line.style.top ?? '-1', 10) === top);
    return match ? lines.indexOf(match) + 1 : -1;
  });
  expect(markedLine).toBe(3);

  // Fixing it clears the underline, without pressing Validate again.
  await setEditorValue(page, '.modal', 'const a = 1;\nconst b = 2;\nreturn a + b;');
  await expect(page.locator('.modal .squiggly-error')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('.check-ok')).toContainText('Parses', { timeout: 20_000 });
});

test('Validate answers on demand, and never runs the code', async ({ page }) => {
  await login(page);
  await openWorkbench(page);

  // An infinite loop. Validating parses and returns; running would not.
  await setEditorValue(page, '.modal', 'while (true) {}\nreturn 1;');
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.locator('.check-ok')).toContainText('Parses', { timeout: 20_000 });
});
