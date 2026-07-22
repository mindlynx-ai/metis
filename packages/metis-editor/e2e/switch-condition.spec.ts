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
 * A switch branch is authored visually - name it, pick a value/operator/amount -
 * with no JSON. Naming the branch labels its canvas handle, and the branch
 * (handle + config) survives a save + reload.
 */
import { test, expect } from '@playwright/test';
import { login, addStep } from './helpers.js';

test('a switch branch is authored with no JSON; its handle + config persist', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/switch-cond/edit');

  await addStep(page, /Webhook Start/);
  await addStep(page, /^Switch/);
  await page.locator('.metis-node', { hasText: 'switch' }).click();
  const inspector = page.locator('.inspector');

  // The branch editor, not a raw JSON textarea.
  await expect(inspector.locator('.switch-builder')).toBeVisible();
  await inspector.getByRole('button', { name: 'Add a branch' }).click();

  const branch = inspector.locator('.switch-branch').first();
  await branch.locator('.switch-branch-name').fill('Big order');
  await branch.locator('.switch-prop').fill('{{step.data.row.amount}}');
  await branch.locator('.kv-op').selectOption('>');
  await branch.locator('.switch-val').fill('100');

  // The canvas switch node now offers a handle for this branch (id the engine
  // routes by) labelled with its name, plus the Otherwise fall-through.
  await expect(page.locator('.react-flow__handle[data-handleid="source-branch-1"]')).toHaveCount(1);
  await expect(page.locator('.react-flow__handle[data-handleid="source-default"]')).toHaveCount(1);
  await expect(page.locator('.fnode-port-label', { hasText: 'Big order' })).toHaveCount(1);

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('.saved-hint')).toBeVisible();

  await page.reload();
  await page.locator('.metis-node', { hasText: 'switch' }).click();
  await expect(inspector.locator('.switch-branch-name')).toHaveValue('Big order');
  await expect(inspector.locator('.switch-val')).toHaveValue('100');
  await expect(page.locator('.react-flow__handle[data-handleid="source-branch-1"]')).toHaveCount(1);
});
