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
 * The canvas journey: sign in, add two steps from the
 * catalogue-driven picker, connect them by dragging handles, save
 * through metis-core, reload and find the graph persisted, then
 * delete a node and persist that too.
 */
import { test, expect } from '@playwright/test';
import { login, addStep } from './helpers.js';

test('build, connect, save, reload, delete: the graph persists through metis-core', async ({
  page,
}) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/e2e-flow/edit');

  await addStep(page, /Webhook Start/);
  await expect(page.locator('.metis-node')).toHaveCount(1);

  await addStep(page, /HTTP API/);
  await expect(page.locator('.metis-node')).toHaveCount(2);

  const sourceHandle = page
    .locator('.metis-node')
    .first()
    .locator('.react-flow__handle-right');
  const targetHandle = page.locator('.metis-node').nth(1).locator('.react-flow__handle-left');

  const dragConnect = async () => {
    const from = await sourceHandle.boundingBox();
    const to = await targetHandle.boundingBox();
    if (!from || !to) return;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await sourceHandle.hover();
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2);
    await page.mouse.up();
  };

  await expect(async () => {
    if ((await page.locator('.react-flow__edge').count()) === 0) await dragConnect();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  }).toPass({ timeout: 15_000 });

  await expect(page.locator('.dirty-hint')).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('.saved-hint')).toBeVisible();

  await page.reload();
  await expect(page.locator('.metis-node')).toHaveCount(2);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  await page.locator('.metis-node').nth(1).click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.metis-node')).toHaveCount(1);
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('.saved-hint')).toBeVisible();

  await page.reload();
  await expect(page.locator('.metis-node')).toHaveCount(1);
});

test('the picker groups apps by category and searches by keyword', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/picker-check/edit');
  await page.getByRole('button', { name: 'Add step' }).click();
  const lib = page.locator('.library');

  // Core building blocks are their own open groups; apps sit in collapsible
  // category sections (Communication among them) so the list scales.
  await expect(lib.getByRole('heading', { name: 'Triggers' })).toBeVisible();
  await expect(lib.locator('summary', { hasText: 'Communication' })).toBeVisible();

  // Storefront: paid tiers render as locked cards, never addable buttons.
  await expect(lib.locator('.locked-card')).toHaveCount(4);
  await expect(lib.locator('.locked-card button')).toHaveCount(0);
  await expect(lib.getByText('cortex.memory.read')).toHaveCount(0);

  // Keyword search: "email" finds the mail providers (by operation/name/synonym)
  // and NOT the chat apps - a flat ranked list, no category headers.
  await lib.getByLabel('Find a step').fill('email');
  const names = lib.locator('.lib-name');
  await expect(names.filter({ hasText: 'SendGrid' })).toHaveCount(1);
  await expect(names.filter({ hasText: 'Resend' })).toHaveCount(1);
  await expect(names.filter({ hasText: 'Slack' })).toHaveCount(0);
  await expect(lib.locator('summary')).toHaveCount(0);

  // A no-match search says so.
  await lib.getByLabel('Find a step').fill('zzzznope');
  await expect(lib.locator('.lib-empty')).toBeVisible();
});
