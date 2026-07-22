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
 * The browser-driven top-to-bottom run: sign in, build a
 * two-node workflow from the palette, connect it, run it, and see the
 * UI report completion while the SQLite record exists behind the API.
 */
import { test, expect } from '@playwright/test';
import { addStep } from '../e2e/helpers.js';

test('build a two-node workflow, run it, and see it complete', async ({ page }) => {
  await page.goto('http://127.0.0.1:4180/login');
  await page.getByLabel('User').fill('admin');
  await page.getByLabel('Password').fill('metis');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);

  const workflowId = `browser-run-${Date.now()}`;
  await page.goto(`http://127.0.0.1:4180/workflows/${workflowId}/edit`);

  // Two nodes: a webhook trigger (a valid published start) and a code step.
  await addStep(page, /^Webhook Start$/);
  await addStep(page, /^Code$/);
  await expect(page.locator('.metis-node')).toHaveCount(2);

  // Configure the code step with a self-contained body.
  await page.locator('.metis-node').nth(1).click();
  const inspector = page.locator('.inspector');
  await inspector
    .locator('[data-field="code"] textarea')
    .fill("return { message: 'ran in the browser' };");
  // Config edits merge live into the flow store; the footer Save persists.
  await inspector.getByRole('button', { name: 'Save', exact: true }).click();

  // Connect the trigger to the code step.
  const sourceHandle = page.locator('.metis-node').first().locator('.react-flow__handle-right');
  const targetHandle = page.locator('.metis-node').nth(1).locator('.react-flow__handle-left');
  await expect(async () => {
    if ((await page.locator('.react-flow__edge').count()) === 0) {
      const from = await sourceHandle.boundingBox();
      const to = await targetHandle.boundingBox();
      if (from && to) {
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await sourceHandle.hover();
        await page.mouse.down();
        await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
        await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2);
        await page.mouse.up();
      }
    }
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  }).toPass({ timeout: 15_000 });

  // Run: saves (create swaps the URL to the server-generated wf_ id),
  // publishes, starts, and replays the run in place on the canvas.
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.toast-info', { hasText: 'Run started' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page).toHaveURL(/\/workflows\/wf_[^/]+\/edit/);
  // Real Temporal completes the run; executed steps paint completed (the
  // trigger node is seeded, not executed, so it never gets a step state).
  // Fit first: a retried edge-drag can double-click-zoom the canvas, and
  // React Flow culls off-viewport nodes to visibility:hidden.
  await page.getByRole('button', { name: 'Fit to view' }).click();
  await expect(page.locator('.metis-node.is-completed').first()).toBeVisible({ timeout: 30_000 });

  // The run reached the store: the Runs page shows it completed...
  await page.goto(`${page.url().replace(/\/edit$/, '')}/runs`);
  const runRow = page.locator('.run-row').first();
  await expect(runRow).toBeVisible({ timeout: 20_000 });
  await expect(runRow.locator('.run-status')).toHaveText('COMPLETED', { timeout: 20_000 });

  // ...and the SQLite record behind the API carries the code output.
  await runRow.click();
  await expect(
    page.locator('.timeline .step', { hasText: 'ran in the browser' }).first(),
  ).toBeVisible({ timeout: 10_000 });
});
