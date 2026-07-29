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
 * Reviews: the queue derived from a parked run, and the dialog that confirms
 * a decision. The two rules worth holding are the ones a person's money runs
 * through: the values the decision turns on are IN FRONT of the approver at
 * the moment they decide, and a rejection cannot be recorded without a
 * reason. Both were impossible in the window.prompt this replaced.
 */
import { test, expect } from '@playwright/test';
import { login } from './helpers.js';

test('the queue shows the parked approval with the facts it turns on', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/reviews');

  const row = page.locator('.runs-table tbody tr', { hasText: 'Refund order 4182' });
  await expect(row).toBeVisible();
  await expect(row.locator('.review-fields')).toContainText('Ada Lovelace');
  await expect(row.locator('.review-fields')).toContainText('GBP 250.00');
});

test('rejecting insists on a reason; approving does not', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/reviews');

  const row = page.locator('.runs-table tbody tr', { hasText: 'Refund order 4182' });
  await row.getByRole('button', { name: 'Reject' }).click();

  const dialog = page.getByRole('dialog', { name: 'Reject this request' });
  await expect(dialog).toBeVisible();
  // The amount is in the dialog, not only on the page behind it.
  await expect(dialog.locator('.decision-facts')).toContainText('GBP 250.00');
  await expect(dialog.locator('#decision-reason')).toBeFocused();

  const confirm = dialog.getByRole('button', { name: 'Reject' });
  await expect(confirm).toBeDisabled();
  await dialog.locator('#decision-reason').fill('   ');
  await expect(confirm).toBeDisabled();
  await dialog.locator('#decision-reason').fill('Courier confirmed the damage was ours');
  await expect(confirm).toBeEnabled();

  // Escape backs out without deciding anything.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // An approval stands on the approver's name, so its note stays optional.
  await row.getByRole('button', { name: 'Approve' }).click();
  const approve = page.getByRole('dialog', { name: 'Approve this request' });
  await expect(approve.getByRole('button', { name: 'Approve' })).toBeEnabled();
});

test('a decision posts to the run own signal and reports back', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/reviews');

  const row = page.locator('.runs-table tbody tr', { hasText: 'Refund order 4182' });
  await row.getByRole('button', { name: 'Approve' }).click();

  const signalled = page.waitForRequest(
    (request) =>
      request.url().includes('/api/executions/exec_seeded_running/signal') &&
      request.method() === 'POST',
  );
  await page
    .getByRole('dialog', { name: 'Approve this request' })
    .getByRole('button', { name: 'Approve' })
    .click();

  const request = await signalled;
  // The approver is NOT in the body: the server stamps the session on it.
  const body = JSON.parse(request.postData() ?? '{}');
  expect(body).toMatchObject({ signalType: 'approval', signalParams: { decision: 'approved' } });
  expect(JSON.stringify(body)).not.toContain('signalledBy');
  await expect(page.locator('.toast-message')).toContainText('Approved');
});
