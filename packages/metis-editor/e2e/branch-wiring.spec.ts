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
 * A branch node (Logic / Switch) must expose handles whose ids are exactly what
 * the engine routes by - a Logic node by `true` / `false`, a Switch by
 * `source-<option>` / `source-default`. The old build rendered `yes` / `no`,
 * so an edge a user drew from a branch pointed at a target that never fired.
 * This guards that the branch is wireable on the canvas and the wire persists.
 */
import { test, expect } from '@playwright/test';
import { login, addStep } from './helpers.js';

test('a Logic branch exposes true/false handles, and its branch wires + persists', async ({
  page,
}) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/branch-wire/edit');

  await addStep(page, /Webhook Start/);
  await addStep(page, /^Logic/);
  await expect(page.locator('.metis-node')).toHaveCount(2);

  // The branch handles carry the engine's routing ids, not the old yes/no.
  await expect(page.locator('.react-flow__handle[data-handleid="true"]')).toHaveCount(1);
  await expect(page.locator('.react-flow__handle[data-handleid="false"]')).toHaveCount(1);
  await expect(page.locator('.react-flow__handle[data-handleid="yes"]')).toHaveCount(0);

  await addStep(page, /HTTP API/);
  await expect(page.locator('.metis-node')).toHaveCount(3);

  // Wire the "true" branch to the HTTP node by dragging the handle.
  const trueHandle = page.locator('.react-flow__handle[data-handleid="true"]');
  const httpTarget = page
    .locator('.metis-node', { hasText: 'HTTP' })
    .locator('.react-flow__handle-left');
  const drag = async () => {
    const from = await trueHandle.boundingBox();
    const to = await httpTarget.boundingBox();
    if (!from || !to) return;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await trueHandle.hover();
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2);
    await page.mouse.up();
  };
  await expect(async () => {
    if ((await page.locator('.react-flow__edge').count()) === 0) await drag();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  }).toPass({ timeout: 15_000 });

  // The wire survives a save + reload (it persisted with its branch handle).
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('.saved-hint')).toBeVisible();
  await page.reload();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
});

test('a Switch renders a fall-through branch handle (source-default)', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/switch-handles/edit');

  await addStep(page, /Webhook Start/);
  await addStep(page, /^Switch/);
  // Even with no options configured, the engine's default branch is offered.
  await expect(page.locator('.react-flow__handle[data-handleid="source-default"]')).toHaveCount(1);
  await expect(page.locator('.react-flow__handle[data-handleid="yes"]')).toHaveCount(0);
});
