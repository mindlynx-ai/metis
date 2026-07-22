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
 * The n8n-gap flow nodes in the editor: all three are addable from the picker,
 * Stop and Error is terminal (no output handle) with a message that persists,
 * and Merge's mode select persists. Config is node-specific; I/O stays generic.
 */
import { test, expect } from '@playwright/test';
import { login, addStep } from './helpers.js';

test('stop and error: terminal node, message persists', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/flow-stop/edit');

  await addStep(page, /Webhook Start/);
  await addStep(page, /Stop and Error/);
  await expect(page.locator('.metis-node')).toHaveCount(2);

  // Terminal: no source handle on the stop node (nothing can be wired onwards).
  const stopNode = page.locator('.metis-node[data-node-type="stopanderror"]');
  await expect(stopNode.locator('.react-flow__handle-right')).toHaveCount(0);

  await stopNode.click();
  const inspector = page.locator('.inspector');
  await inspector.locator('[data-field="message"] input, [data-field="message"] textarea').first()
    .fill('Order rejected: over the limit');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('.saved-hint')).toBeVisible();

  await page.reload();
  await page.locator('.metis-node[data-node-type="stopanderror"]').click();
  await expect(
    inspector.locator('[data-field="message"] input, [data-field="message"] textarea').first(),
  ).toHaveValue('Order rejected: over the limit');
});

test('merge: mode select persists; noop needs no settings', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/flow-merge/edit');

  await addStep(page, /Webhook Start/);
  await addStep(page, /^Merge/);
  await page.locator('.metis-node[data-node-type="merge"]').click();
  const inspector = page.locator('.inspector');
  await inspector.locator('[data-field="mode"] select').selectOption('combine');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('.saved-hint')).toBeVisible();

  await page.reload();
  await page.locator('.metis-node[data-node-type="merge"]').click();
  await expect(inspector.locator('[data-field="mode"] select')).toHaveValue('combine');

  await addStep(page, /No Operation/);
  await page.locator('.metis-node[data-node-type="noop"]').click();
  await expect(inspector.getByText('This step needs no settings.')).toBeVisible();
});

test('filter: conditions authored visually persist; kept/discarded handles render', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/flow-filter/edit');

  await addStep(page, /Webhook Start/);
  await addStep(page, /^Filter/);
  const filterNode = page.locator('.metis-node[data-node-type="filter"]');
  await expect(filterNode.locator('.react-flow__handle[data-handleid="kept"]')).toHaveCount(1);
  await expect(filterNode.locator('.react-flow__handle[data-handleid="discarded"]')).toHaveCount(1);

  await filterNode.click();
  const inspector = page.locator('.inspector');
  await inspector.locator('[data-field="items"] input').fill('{{step.data.rows}}');
  await inspector.getByRole('button', { name: 'Add condition' }).click();
  const row = inspector.locator('.switch-cond').first();
  await row.locator('.logic-field').fill('status');
  await row.locator('.kv-op').selectOption('===');
  await row.locator('.switch-val').fill('paid');

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('.saved-hint')).toBeVisible();
  await page.reload();
  await page.locator('.metis-node[data-node-type="filter"]').click();
  await expect(inspector.locator('.switch-cond .logic-field').first()).toHaveValue('status');
  await expect(inspector.locator('.switch-cond .switch-val').first()).toHaveValue('paid');
});

test('the Guide tab explains a node: what it is, how it works', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/guide-check/edit');

  await addStep(page, /^Loop/);
  await page.locator('.metis-node[data-node-type="loop"]').click();
  const inspector = page.locator('.inspector');

  await inspector.getByRole('tab', { name: 'Guide' }).click();
  await expect(inspector.locator('.guide-panel h4').first()).toHaveText(/what it is/i);
  await expect(inspector.locator('.guide-panel')).toContainText('child workflow');

  // A node without docs (a generated connector node) offers no Guide tab.
  await addStep(page, /^Slack/);
  await page.locator('.metis-node[data-node-type="slack"]').click();
  await expect(inspector.getByRole('tab', { name: 'Guide' })).toHaveCount(0);
  // And the inspector fell back to Setup rather than a dead guide panel.
  await expect(inspector.getByRole('tab', { name: 'Setup' })).toHaveAttribute('aria-selected', 'true');
});

test('compare datasets: four handles render and config persists', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/flow-compare/edit');

  await addStep(page, /Webhook Start/);
  await addStep(page, /Compare Datasets/);
  const compareNode = page.locator('.metis-node[data-node-type="comparedatasets"]');
  for (const handle of ['aOnly', 'same', 'different', 'bOnly']) {
    await expect(compareNode.locator(`.react-flow__handle[data-handleid="${handle}"]`)).toHaveCount(1);
  }

  await compareNode.click();
  const inspector = page.locator('.inspector');
  await inspector.locator('[data-field="matchFields"] input').fill('email');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('.saved-hint')).toBeVisible();
  await page.reload();
  await page.locator('.metis-node[data-node-type="comparedatasets"]').click();
  await expect(inspector.locator('[data-field="matchFields"] input')).toHaveValue('email');
});
