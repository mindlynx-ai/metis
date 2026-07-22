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
 * The execution viewer: seeded history renders with
 * per-node logs and timings, live status streams over the WebSocket
 * and flips the run to completed, and the Temporal raw view is linked.
 */
import { test, expect } from '@playwright/test';
import { login, addStep } from './helpers.js';

test('run history renders from the gateway with per-node logs', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/wf-runs-demo/runs');

  const seeded = page.locator('.run-row', { hasText: 'exec_seeded_1' });
  await expect(seeded).toBeVisible();
  await expect(seeded.locator('.run-status')).toHaveText('COMPLETED');

  await seeded.click();
  const timeline = page.locator('.timeline .step');
  await expect(timeline).toHaveCount(2);
  await expect(timeline.first()).toContainText('node-demo-a');
  await expect(timeline.first()).toContainText('workflow.node.completed');
  await expect(timeline.first()).toContainText('2026-07-03T11:58:00.400Z');

  const link = page.locator('.temporal-link');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', /8233/);
});

test('a live run streams status over the WebSocket and flips to completed', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/wf-runs-demo/runs');
  await expect(page.locator('.run-row').first()).toBeVisible();

  const executionId = `exec_live_${Date.now()}`;
  await page.evaluate(async (id) => {
    await fetch('/e2e/simulate-run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executionId: id }),
    });
  }, executionId);

  const liveRow = page.locator('.run-row', { hasText: executionId });
  await page.reload();
  await expect(liveRow).toBeVisible();
  await liveRow.click();

  await expect(liveRow.locator('.run-status')).toHaveText('COMPLETED', { timeout: 10_000 });
  await expect(
    page.locator('.timeline .step.live', { hasText: 'workflow.execution.completed' }),
  ).toBeVisible();
  await expect(
    page.locator('.timeline .step.live', { hasText: 'node-live-a' }).first(),
  ).toBeVisible();
});

test('an execution deep-links to a full detail page with meta and steps', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/executions/exec_seeded_1');

  await expect(page.locator('.exec-id')).toHaveText('exec_seeded_1');
  await expect(page.locator('.exec-meta .status')).toHaveText('completed');
  await expect(page.locator('.exec-meta')).toContainText('Took');
  await expect(page.locator('.timeline .step')).toHaveCount(2);
  await expect(page.locator('.timeline .step').first()).toContainText('node-demo-a');
});

test('operate drills through to the execution detail', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/operate');

  const row = page.locator('section[aria-label="Runs board"] tbody tr', { hasText: 'exec_seeded_1' });
  await expect(row).toBeVisible();
  await row.getByRole('link').click();
  await expect(page).toHaveURL(/\/executions\/exec_seeded_1$/);
  await expect(page.locator('.timeline .step')).toHaveCount(2);
});

test('versioning: the run shows its definition version; the builder lists history', async ({ page }) => {
  await login(page);

  // The run detail carries which definition version it executed.
  await page.goto('http://127.0.0.1:4180/executions/exec_seeded_1');
  await expect(page.locator('.exec-meta .ver-chip')).toHaveText('v1\u00b7c0');

  // The board row carries the same chip.
  await page.goto('http://127.0.0.1:4180/operate');
  await expect(
    page.locator('section[aria-label="Runs board"] tbody tr', { hasText: 'exec_seeded_1' }).locator('.ver-chip'),
  ).toHaveText('v1\u00b7c0');

  // The builder's Versions panel lists the changeset history.
  await page.goto('http://127.0.0.1:4180/workflows/wf-runs-demo/edit');
  await page.getByRole('button', { name: 'Versions' }).click();
  const row = page.locator('.versions-row').first();
  await expect(row).toContainText('v1\u00b7c0');
  await expect(row.locator('.status')).toHaveText('published');
  await expect(row).toContainText('2 steps');
});

test('a finished run replays on the canvas: outcomes coloured, orphans greyed', async ({ page }) => {
  await login(page);

  // From the run detail, View on canvas deep-links the builder in run view.
  await page.goto('http://127.0.0.1:4180/executions/exec_seeded_1');
  await page.getByRole('link', { name: 'View on canvas' }).click();
  await expect(page).toHaveURL(/\/workflows\/wf-runs-demo\/edit\?run=exec_seeded_1$/);

  // The banner names the run; the taken step is green, the untaken grey.
  await expect(page.locator('.replay-banner')).toContainText('exec_seeded_1');
  await expect(page.locator('.metis-node[data-node-type="webhookconfig"]')).toHaveClass(/is-completed/);
  await expect(page.locator('.metis-node[data-node-type="signal"]')).toHaveClass(/is-orphaned/);

  // Exit returns to the plain builder.
  await page.getByRole('button', { name: 'Exit run view' }).click();
  await expect(page.locator('.replay-banner')).toHaveCount(0);
  await expect(page.locator('.metis-node.is-completed')).toHaveCount(0);
});

test('a failed run shows its error and the attempts used', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/executions/exec_seeded_failed');

  await expect(page.locator('.exec-meta .status')).toHaveText('failed');
  const failedStep = page.locator('.timeline .step.failed');
  await expect(failedStep).toContainText('node-fails');
  await expect(failedStep.locator('.step-error')).toHaveText('upstream returned 500');
  await expect(failedStep.locator('.step-attempts')).toHaveText('3 attempts');
});

test('an unknown execution shows a friendly empty state', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/executions/exec_nope');
  await expect(page.locator('.empty-card')).toContainText('No stored detail for this run.');
  await expect(page.getByRole('link', { name: 'Back to Operate' })).toBeVisible();
});

test('the builder Run button runs in place and paints step states, without leaving', async ({
  page,
}) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/new');
  await addStep(page, /Webhook Start/);
  await addStep(page, /^Code/);
  const sourceHandle = page.locator('.metis-node').first().locator('.react-flow__handle-right');
  const targetHandle = page.locator('.metis-node').nth(1).locator('.react-flow__handle-left');
  await expect(async () => {
    if ((await page.locator('.react-flow__edge').count()) === 0) {
      const from = await sourceHandle.boundingBox();
      const to = await targetHandle.boundingBox();
      if (from && to) {
        await sourceHandle.hover();
        await page.mouse.down();
        await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
        await page.mouse.up();
      }
    }
    await expect(page.locator('.react-flow__edge')).toHaveCount(1, { timeout: 500 });
  }).toPass();

  await page.getByRole('button', { name: 'Run', exact: true }).click();

  // Stays on the builder (edit URL, not the runs page), announces the run, and
  // paints the finished step state onto the canvas node.
  await expect(page.locator('.toast-info', { hasText: 'Run started' })).toBeVisible();
  await expect(page).toHaveURL(/\/workflows\/wf_[^/]+\/edit/);
  await expect(page.locator('.metis-node.is-completed').first()).toBeVisible({ timeout: 15000 });
});
