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
 * The logic node's rule is built visually - an AND/OR/NOT predicate tree - with
 * no JSON, and it persists a save + reload.
 */
import { test, expect } from '@playwright/test';
import { login, addStep } from './helpers.js';

test('a logic rule is built with AND/OR/NOT (no JSON) and persists', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/logic-rule/edit');

  await addStep(page, /Webhook Start/);
  await addStep(page, /^Logic/);
  await page.locator('.metis-node', { hasText: 'logic' }).click();
  const inspector = page.locator('.inspector');

  // The predicate-tree builder, not a raw JSON object.
  await expect(inspector.locator('.logic-builder')).toBeVisible();
  await expect(inspector.locator('.pred-group').first().getByRole('tab', { name: 'AND' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // Fill the first leaf: the trigger input's amount greater than 100.
  const leaf = inspector.locator('.pred-leaf').first();
  await leaf.locator('.logic-field').fill('ctx.input.amount');
  await leaf.locator('.kv-op').selectOption('gt');
  await leaf.locator('.switch-val').fill('100');

  // Switch the group to OR and add a second condition.
  await inspector.locator('.pred-group').first().getByRole('tab', { name: 'OR' }).click();
  await inspector.getByRole('button', { name: 'Add condition' }).first().click();
  await expect(inspector.locator('.pred-leaf')).toHaveCount(2);

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('.saved-hint')).toBeVisible();

  await page.reload();
  await page.locator('.metis-node', { hasText: 'logic' }).click();
  await expect(inspector.locator('.pred-leaf').first().locator('.switch-val')).toHaveValue('100');
  await expect(inspector.locator('.pred-leaf')).toHaveCount(2);
  await expect(inspector.locator('.pred-group').first().getByRole('tab', { name: 'OR' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
