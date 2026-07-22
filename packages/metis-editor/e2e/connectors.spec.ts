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
 * The Connectors surface: connections as branded cards, connected through a
 * modal that browses the catalogue, shows a service's real credential fields
 * and tests them before saving. A connection then edits (rename + rotate) and a
 * typed node can pick it. Credentials are per-connector, never a single key.
 */
import { test, expect, type Page } from '@playwright/test';
import { login, addStep } from './helpers.js';

const openConnect = async (page: Page) => {
  await page.goto('http://127.0.0.1:4180/connectors');
  await page.locator('.conn-connect-btn').click();
  await expect(page.locator('.modal')).toBeVisible();
};

test('connect a service (GitHub): browse the catalogue, its own fields, a card appears', async ({ page }) => {
  await login(page);
  await openConnect(page);
  const modal = page.locator('.modal');

  // "A service" is the default: a searchable, branded catalogue grid.
  await modal.locator('.svc-search').fill('GitHub');
  await modal.locator('.svc-tile', { hasText: 'GitHub' }).first().click();

  // The chosen service shows its OWN credential field (a PAT), not a generic key.
  await expect(modal.locator('.conn-chosen-name')).toHaveText('GitHub');
  await expect(modal.locator('#add-token')).toHaveAttribute('type', 'password');
  await modal.locator('#add-name').fill('GitHub Prod');
  await modal.locator('#add-token').fill('ghp_x');
  await modal.getByRole('button', { name: 'Connect', exact: true }).click();

  await expect(page.locator('.modal')).toHaveCount(0);
  const card = page.locator('.conn-card', { hasText: 'GitHub Prod' });
  await expect(card).toHaveCount(1);
  await expect(card.locator('.conn-card-sub')).toHaveText('GitHub');
});

test('Stripe is not a single key: the connect form shows three fields', async ({ page }) => {
  await login(page);
  await openConnect(page);
  const modal = page.locator('.modal');

  await modal.locator('.svc-search').fill('Stripe');
  await modal.locator('.svc-tile', { hasText: 'Stripe' }).first().click();

  // Secret key + publishable key + webhook signing secret - not one "API key".
  await expect(modal.locator('#add-secretKey')).toBeVisible();
  await expect(modal.locator('#add-publishableKey')).toBeVisible();
  await expect(modal.locator('#add-webhookSecret')).toBeVisible();
  await expect(modal.locator('#add-secretKey')).toHaveAttribute('type', 'password');
  await expect(modal.locator('#add-publishableKey')).toHaveAttribute('type', 'text');
});

test('connect a Database; the card shows its health', async ({ page }) => {
  await login(page);
  await openConnect(page);
  const modal = page.locator('.modal');

  await modal.getByRole('tab', { name: 'Database' }).click();
  await modal.locator('#add-name').fill('Staging DB');
  await modal.locator('#add-engine').selectOption('postgres');
  await modal.locator('#add-host').fill('127.0.0.1');
  await modal.locator('#add-port').fill('1');
  await modal.locator('#add-database').fill('metis');
  await modal.locator('#add-user').fill('metis');
  await modal.locator('#add-password').fill('metis');
  await modal.getByRole('button', { name: 'Connect', exact: true }).click();

  const card = page.locator('.conn-card', { hasText: 'Staging DB' });
  await expect(card).toHaveCount(1);
  await expect(card.locator('.conn-badge')).toHaveText(/Unreachable|Error|Auth failed/, { timeout: 15000 });
});

test('edit a connection: rename it in a modal, the card updates', async ({ page }) => {
  await login(page);
  await openConnect(page);
  const modal = page.locator('.modal');
  await modal.locator('.svc-search').fill('GitHub');
  await modal.locator('.svc-tile', { hasText: 'GitHub' }).first().click();
  await modal.locator('#add-name').fill('Edit Me');
  await modal.locator('#add-token').fill('ghp_x');
  await modal.getByRole('button', { name: 'Connect', exact: true }).click();

  const card = page.locator('.conn-card', { hasText: 'Edit Me' });
  await expect(card).toHaveCount(1);

  await card.getByRole('button', { name: 'Edit' }).click();
  const edit = page.locator('.modal');
  await expect(edit.locator('#edit-name')).toHaveValue('Edit Me');
  // The secret field is blank with an "Unchanged" placeholder (write-only).
  await expect(edit.locator('#edit-token')).toHaveAttribute('placeholder', 'Unchanged');
  await edit.locator('#edit-name').fill('Renamed Connection');
  await edit.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('.conn-card', { hasText: 'Renamed Connection' })).toHaveCount(1);
  await expect(page.locator('.conn-card', { hasText: 'Edit Me' })).toHaveCount(0);
});

test('the connections switch between card and list views', async ({ page }) => {
  await login(page);
  await openConnect(page);
  const modal = page.locator('.modal');
  await modal.locator('.svc-search').fill('GitHub');
  await modal.locator('.svc-tile', { hasText: 'GitHub' }).first().click();
  await modal.locator('#add-name').fill('Viewable');
  await modal.locator('#add-token').fill('ghp_x');
  await modal.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.conn-card', { hasText: 'Viewable' })).toHaveCount(1);

  // Switch to list view: a row table replaces the card grid, and it persists.
  await page.getByRole('button', { name: 'List view' }).click();
  await expect(page.locator('.conn-grid')).toHaveCount(0);
  await expect(page.locator('.conn-list .conn-lrow', { hasText: 'Viewable' })).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.conn-list')).toBeVisible();

  // Back to cards.
  await page.getByRole('button', { name: 'Card view' }).click();
  await expect(page.locator('.conn-grid')).toBeVisible();
});

test('editing a multi-field connection pre-fills non-secret values, hides secrets', async ({ page }) => {
  await login(page);
  await openConnect(page);
  const modal = page.locator('.modal');
  await modal.locator('.svc-search').fill('Stripe');
  await modal.locator('.svc-tile', { hasText: 'Stripe' }).first().click();
  await modal.locator('#add-name').fill('Stripe Edit');
  await modal.locator('#add-secretKey').fill('sk_test_x');
  await modal.locator('#add-publishableKey').fill('pk_test_visible');
  await modal.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.conn-card', { hasText: 'Stripe Edit' })).toHaveCount(1);

  await page.locator('.conn-card', { hasText: 'Stripe Edit' }).getByRole('button', { name: 'Edit' }).click();
  const edit = page.locator('.modal');
  // All three fields present; the non-secret publishable key is pre-filled; the
  // secret key comes back blank (write-only) with an "Unchanged" placeholder.
  await expect(edit.locator('#edit-secretKey')).toHaveValue('');
  await expect(edit.locator('#edit-secretKey')).toHaveAttribute('placeholder', 'Unchanged');
  await expect(edit.locator('#edit-publishableKey')).toHaveValue('pk_test_visible');
  await expect(edit.locator('#edit-webhookSecret')).toBeVisible();
});

test('a connected service can be picked by a typed node', async ({ page }) => {
  await login(page);
  await openConnect(page);
  const modal = page.locator('.modal');
  await modal.locator('.svc-search').fill('GitHub');
  await modal.locator('.svc-tile', { hasText: 'GitHub' }).first().click();
  await modal.locator('#add-name').fill('GitHub Nodes');
  await modal.locator('#add-token').fill('ghp_x');
  await modal.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.conn-card', { hasText: 'GitHub Nodes' })).toHaveCount(1);

  await page.goto('http://127.0.0.1:4180/workflows/inspector-github-conn/edit');
  await addStep(page, /GitHub/);
  await page.locator('.metis-node').first().click();
  const sel = page.locator('.inspector .connector-picker #conn-conn');
  await expect(sel.locator('option', { hasText: 'GitHub Nodes' })).toHaveCount(1);
});

test('removing a connection asks for confirmation first', async ({ page }) => {
  await login(page);
  await openConnect(page);
  const modal = page.locator('.modal');
  await modal.locator('.svc-search').fill('GitHub');
  await modal.locator('.svc-tile', { hasText: 'GitHub' }).first().click();
  await modal.locator('#add-name').fill('Guarded');
  await modal.locator('#add-token').fill('ghp_x');
  await modal.getByRole('button', { name: 'Connect', exact: true }).click();
  const card = page.locator('.conn-card', { hasText: 'Guarded' });
  await expect(card).toHaveCount(1);

  // Escape cancels: the connection stays.
  await card.getByRole('button', { name: 'Remove' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Remove "Guarded"?');
  await page.keyboard.press('Escape');
  await expect(page.locator('.conn-card', { hasText: 'Guarded' })).toHaveCount(1);

  // Enter confirms (the confirm button holds focus): removed + a toast.
  await card.getByRole('button', { name: 'Remove' }).click();
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast-success', { hasText: 'Connection removed' })).toBeVisible();
  await expect(page.locator('.conn-card', { hasText: 'Guarded' })).toHaveCount(0);
});
