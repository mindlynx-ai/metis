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
 * Operate - the ONE runs surface (History merged in): the hero + pill + duration
 * identity, counts + worker health, server-side filters, run actions, schedules,
 * the /history redirect and the origin-aware back-link from the run detail.
 */
import { test, expect } from '@playwright/test';
import { login } from './helpers.js';

test('operate is the one runs surface: hero, pills, durations, counts, actions', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/operate');

  // The merged identity: hero band + the former History's definition copy.
  await expect(page.locator('.page-hero .page-title')).toHaveText('Operate');
  await expect(page.locator('.page-hero-sub')).toContainText('Every run of every workflow');
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();

  // Headline counts + worker health from /api/operate/summary.
  await expect(page.locator('.op-count.op-completed .op-count-value')).toHaveText('7');
  await expect(page.getByTestId('worker-health')).toContainText('workers polling');
  await expect(page.getByTestId('worker-health')).toContainText('metis-workflow-tasks');

  // Runs render with the tinted status pill and a computed duration.
  const board = page.locator('section[aria-label="Runs board"]');
  const completedRow = board.locator('tbody tr', { hasText: 'exec_seeded_1' });
  await expect(completedRow.locator('.status')).toHaveText('completed');
  await expect(completedRow).toContainText('2.0s');
  await expect(
    board.locator('tbody tr', { hasText: 'exec_seeded_failed' }).locator('.status'),
  ).toHaveText('failed');

  // Row identity: the METIS workflow name leads; executionId + runId beneath.
  await expect(completedRow.getByRole('link')).toHaveText('Order approvals');
  await expect(completedRow).toContainText('exec_seeded_1');
  await expect(completedRow).toContainText('run run-seed');
  await expect(completedRow.getByRole('button', { name: /Copy runId/ })).toBeVisible();

  // Upcoming: the executions that are GOING to run, from schedule fire times.
  const upcomingSection = page.locator('section[aria-label="Upcoming runs"]');
  await expect(upcomingSection).toContainText('Daily digest');
  await expect(upcomingSection.locator('.upcoming-item')).toHaveCount(2);

  // The board lists the seeded runs; filtering asks the SERVER for Running only.
  await expect(board.locator('tbody tr')).toHaveCount(3);
  await page.getByRole('tab', { name: 'Running' }).click();
  await expect(board.locator('tbody tr')).toHaveCount(1);
  const runningRow = board.locator('tbody tr').first();
  await expect(runningRow).toContainText('exec_seeded_running');

  // The running run is PARKED on a signal: the amber waiting pill + reason.
  await expect(runningRow.locator('.status')).toHaveText('waiting');
  await expect(runningRow).toContainText('waiting for signal: approval');
  await page.getByRole('tab', { name: 'Waiting' }).click();
  await expect(board.locator('tbody tr', { hasText: 'exec_seeded_running' })).toBeVisible();
  await page.getByRole('tab', { name: 'Running' }).click();

  // A running run offers the operator levers; terminate + reset round-trip.
  await expect(runningRow.getByRole('button', { name: 'Cancel' })).toBeVisible();
  const terminated = page.waitForResponse((response) =>
    response.url().includes('/terminate') && response.status() === 202,
  );
  await runningRow.getByRole('button', { name: 'Terminate' }).click();
  await terminated;

  const reset = page.waitForResponse((response) =>
    response.url().includes('/reset') && response.status() === 202,
  );
  await board.locator('tbody tr').first().getByRole('button', { name: 'Reset' }).click();
  await reset;
});

test('operate: schedules panel lists Temporal Schedules and pause round-trips', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/operate');

  const schedulesSection = page.locator('section[aria-label="Schedules"]');
  await expect(schedulesSection).toBeVisible();
  const row = schedulesSection.locator('tbody tr').first();
  await expect(row).toContainText('Daily digest');
  await expect(row).toContainText('0 9 * * *');
  await expect(row).toContainText('active');

  const paused = page.waitForResponse(
    (response) => response.url().includes('/schedules/wf-daily/pause') && response.status() === 202,
  );
  await row.getByRole('button', { name: 'Pause' }).click();
  await paused;
});

test('run detail: family, retries, waiting signal form round-trips', async ({ page }) => {
  await login(page);

  // The completed parent lists its loop children; children link back.
  await page.goto('http://127.0.0.1:4180/executions/exec_seeded_1');
  const family = page.locator('section[aria-label="Related runs"]');
  await expect(family).toContainText('exec_seeded_1-loop-node-0');
  await expect(family).toContainText('exec_seeded_1-loop-node-1');
  await family.getByRole('link', { name: 'exec_seeded_1-loop-node-0' }).click();
  await expect(page).toHaveURL(/exec_seeded_1-loop-node-0$/);

  // The parked run explains itself and prefills the signal it waits for.
  await page.goto('http://127.0.0.1:4180/executions/exec_seeded_running');
  await expect(page.locator('.exec-waiting')).toContainText('waiting for signal: approval');
  await expect(page.getByLabel('Signal name')).toHaveValue('approval');
  await expect(page.locator('section[aria-label="Pending retries"]')).toContainText('attempt 4 of 10');
  const signalled = page.waitForResponse(
    (response) => response.url().includes('/signal') && response.status() === 202,
  );
  await page.getByRole('button', { name: 'Send signal' }).click();
  await signalled;

  // Download exists (the archive escape hatch).
  await expect(page.getByRole('button', { name: 'Download JSON' })).toBeVisible();
});

test('operate: backlog on the worker tile and saved views', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/operate');

  await expect(page.getByTestId('worker-health')).toContainText('3 queued, oldest 12s');

  // Save the Failed filter as a named view; the chip re-applies it.
  page.on('dialog', (dialog) => {
    dialog.accept('My failures').catch(() => undefined);
  });
  await page.getByRole('tab', { name: 'Failed' }).click();
  await page.getByRole('button', { name: 'Save view' }).click();
  await expect(page.locator('.view-chip')).toContainText('My failures');
  await page.getByRole('tab', { name: 'All' }).click();
  await page.locator('.view-chip-apply', { hasText: 'My failures' }).click();
  await expect(page.getByRole('tab', { name: 'Failed' })).toHaveAttribute('aria-selected', 'true');
});

test('the archive lists runs Temporal forgot, still fully inspectable', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/operate');

  const archive = page.locator('section[aria-label="Archive"]');
  await expect(archive).toContainText("beyond Temporal's memory");
  await expect(archive).toContainText('for 90 days');
  const row = archive.locator('tbody tr', { hasText: 'exec_seeded_ancient' });
  await expect(row.locator('.status')).toHaveText('completed');
  // The board itself does NOT list it (Temporal's view), only the archive.
  await expect(
    page.locator('section[aria-label="Runs board"] tbody tr', { hasText: 'exec_seeded_ancient' }),
  ).toHaveCount(0);

  // Still fully inspectable: the store-backed detail opens with its steps.
  await row.getByRole('link').click();
  await expect(page).toHaveURL(/exec_seeded_ancient$/);
  await expect(page.locator('.timeline .step')).toHaveCount(1);
});

test('/history redirects to operate; the run detail returns to Operate', async ({ page }) => {
  await login(page);

  // Old links keep working: History merged into Operate.
  await page.goto('http://127.0.0.1:4180/history');
  await expect(page).toHaveURL(/\/operate$/);
  await expect(page.locator('.page-hero .page-title')).toHaveText('Operate');

  // Drill into a run; the back-link is origin-aware, not "Back to history".
  await page
    .locator('section[aria-label="Runs board"] tbody tr', { hasText: 'exec_seeded_1' })
    .getByRole('link')
    .click();
  await expect(page).toHaveURL(/\/executions\/exec_seeded_1$/);
  const back = page.getByRole('link', { name: 'Back to Operate' });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(/\/operate$/);
});

for (const theme of ['light', 'dark'] as const) {
  test(`operate holds the identity in ${theme}`, async ({ page }) => {
    await login(page);
    await page.addInitScript((wanted) => localStorage.setItem('metis-theme', wanted), theme);
    await page.goto('http://127.0.0.1:4180/operate');
    await expect(
      page.locator('section[aria-label="Runs board"] tbody tr', { hasText: 'exec_seeded_1' }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);

    // Baselines are recorded on macOS (the design workstation); the volatile
    // time cells are masked so the picture stays stable.
    if (process.platform === 'darwin') {
      await expect(page).toHaveScreenshot(`operate-${theme}.png`, {
        fullPage: false,
        mask: [
          page.locator('.runs-table td:nth-child(3)'),
          page.locator('section[aria-label="Schedules"] td:nth-child(4)'),
        ],
      });
    }
  });
}
