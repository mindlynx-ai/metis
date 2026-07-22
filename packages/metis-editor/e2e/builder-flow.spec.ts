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
 * The builder header lifecycle: New workflow starts empty even after another
 * was open, Save draft / Run / Publish each raise a toast and move the status
 * chip, and the builder carries its own light/dark toggle.
 */
import { test, expect, type Page } from '@playwright/test';
import { login, addStep } from './helpers.js';

const seedWorkflow = (page: Page) =>
  page.evaluate(async () => {
    const token = localStorage.getItem('metis-token');
    const res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Seeded flow',
        nodes: [
          { id: 'a', type: 'webhookconfig', version: 'v1', position: { x: 80, y: 120 }, data: { label: 'Hook', config: {} } },
          { id: 'b', type: 'code', version: 'v1', position: { x: 400, y: 120 }, data: { label: 'Code', config: {} } },
        ],
        edges: [{ id: 'e', source: 'a', target: 'b', sourceHandle: null }],
      }),
    });
    return (await res.json()) as { id: string };
  });

test('New workflow starts from an empty canvas, even after another was open', async ({ page }) => {
  await login(page);
  const { id } = await seedWorkflow(page);

  // Open the seeded workflow: its two nodes are on the canvas.
  await page.goto(`http://127.0.0.1:4180/workflows/${id}/edit`);
  await expect(page.locator('.metis-node')).toHaveCount(2);

  // Back to the list, then New workflow: the canvas must be EMPTY, not the last
  // workflow's graph (the /workflows/new route has no id to load).
  await page.getByRole('link', { name: 'Back to workflows' }).click();
  await page.getByRole('link', { name: 'New workflow' }).click();
  await expect(page).toHaveURL(/\/workflows\/new$/);
  await expect(page.locator('.metis-node')).toHaveCount(0);
  await expect(page.locator('.b-name')).toHaveValue('Untitled workflow');
  await expect(page.locator('.b-status')).toHaveText('Draft');
});

test('Save draft and Publish each raise a toast and move the status chip', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/lifecycle-check/edit');
  await addStep(page, /Webhook Start/);

  // Save draft -> toast, still a draft.
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('.toast-success', { hasText: 'Draft saved' })).toBeVisible();
  await expect(page.locator('.b-status')).toHaveText('Draft');

  // Publish -> toast, chip flips to Published.
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.locator('.toast-success', { hasText: 'is live' })).toBeVisible();
  await expect(page.locator('.b-status')).toHaveText('Published');
});

test('create a workflow from scratch: New, add a step, save, it appears in the list', async ({
  page,
}) => {
  await login(page);
  // Start fresh from the workflows list.
  await page.goto('http://127.0.0.1:4180/workflows');
  await page.getByRole('link', { name: 'New workflow' }).click();
  await expect(page.locator('.metis-node')).toHaveCount(0);

  // Name it, add a step, save.
  const name = `Scratch ${Date.now()}`;
  await page.locator('.b-name').fill(name);
  await addStep(page, /Webhook Start/);
  await expect(page.locator('.metis-node')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save draft' }).click();
  // Saving a new workflow assigns a server id and moves to its /edit URL.
  await expect(page).toHaveURL(/\/workflows\/wf_[^/]+\/edit/);

  // It now shows in the workflows list.
  await page.getByRole('link', { name: 'Back to workflows' }).click();
  await expect(page.locator('.wf-card', { hasText: name })).toBeVisible();
});

test('Run executes a single action step without needing a trigger', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/run-action/edit');
  await addStep(page, /HTTP API/);
  // Run executes the graph once, in place - a lone action node must not be
  // rejected as an invalid definition (that rule is only for Publish), and Run
  // stays on the builder rather than leaving for the runs page.
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('.toast-info', { hasText: 'Run started' })).toBeVisible();
  await expect(page).toHaveURL(/\/workflows\/wf_[^/]+\/edit/);
  // The step ran (a run state paints on the node), rather than the run being rejected.
  await expect(page.locator('.metis-node.is-completed, .metis-node.is-failed')).toBeVisible({
    timeout: 15000,
  });
});

test('Publish on a triggerless graph explains it needs a trigger, and stays a draft', async ({
  page,
}) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/publish-notrigger/edit');
  await addStep(page, /HTTP API/);
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.locator('.toast-error', { hasText: /trigger/i })).toBeVisible();
  await expect(page.locator('.b-status')).toHaveText('Draft');
});

test('the builder carries its own theme toggle', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('metis-theme', 'dark'));
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/theme-check/edit');
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await page.getByRole('button', { name: 'Switch color theme' }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
});
