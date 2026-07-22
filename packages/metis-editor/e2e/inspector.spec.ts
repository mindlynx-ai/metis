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
 * The node inspector: the premium right-side panel. Entries render
 * their Setup form from schema alone (with rich method/headers widgets), a
 * keyboard tablist gates Setup/Test/History/Policy, edits merge live, and a
 * save round-trips exactly. It is always a right panel, never a modal.
 */
import { test, expect } from '@playwright/test';
import { login, addStep } from './helpers.js';

test('three differently-shaped entries render from their schemas alone', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/inspector-shapes/edit');
  const inspector = page.locator('.inspector');
  const name = inspector.getByLabel('Step name');

  await addStep(page, /HTTP API/);
  await page.locator('.metis-node').first().click();
  await expect(name).toHaveValue('HTTP API');
  await expect(inspector.locator('[data-field="url"] input')).toBeVisible();
  // Method is a set of pills, not a select.
  await expect(inspector.locator('[data-field="method"] .method-pills')).toBeVisible();
  await inspector.locator('.disclosure > summary').click();
  await expect(inspector.locator('[data-field="timeout"] input[type="number"]')).toBeVisible();
  // Headers are a key/value editor, not raw JSON.
  await expect(inspector.locator('[data-field="headers"] .kv-editor')).toBeVisible();

  await addStep(page, /Wait Until/);
  await page.locator('.metis-node').nth(1).click();
  await expect(name).toHaveValue('Wait Until');
  await expect(inspector.locator('[data-field="waitMinutes"] input[type="number"]')).toBeVisible();
  await expect(inspector.locator('[data-field="dateFrom"] input')).toBeVisible();

  await addStep(page, /^Code/);
  await page.locator('.metis-node').nth(2).click();
  await expect(name).toHaveValue('Code');
  await expect(inspector.locator('[data-field="code"] textarea')).toBeVisible();
});

test('edits merge live, save and read back exactly', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/inspector-http/edit');

  await addStep(page, /HTTP API/);
  await page.locator('.metis-node').first().click();
  const inspector = page.locator('.inspector');
  await inspector.getByLabel('Step name').fill('Create order');
  await inspector.locator('[data-field="url"] input').fill('https://api.example.test/orders');
  await inspector.locator('[data-field="method"]').getByRole('button', { name: 'POST', exact: true }).click();

  // The footer Save persists and moves to the new id's URL.
  await inspector.locator('.ins-foot .btn-primary').click();
  await expect(page).toHaveURL(/\/workflows\/wf_[^/]+\/edit/);

  await page.reload();
  await page.locator('.metis-node').first().click();
  await expect(inspector.getByLabel('Step name')).toHaveValue('Create order');
  await expect(inspector.locator('[data-field="url"] input')).toHaveValue(
    'https://api.example.test/orders',
  );
  await expect(
    inspector.locator('[data-field="method"] .pill.active'),
  ).toHaveText('POST');
});

test('the headers editor adds and edits rows', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/inspector-headers/edit');
  await addStep(page, /HTTP API/);
  await page.locator('.metis-node').first().click();
  const inspector = page.locator('.inspector');
  await inspector.locator('.disclosure > summary').click();

  const headers = inspector.locator('[data-field="headers"]');
  await expect(headers.locator('.kv-row')).toHaveCount(1);
  await headers.getByRole('button', { name: 'Add header' }).click();
  await expect(headers.locator('.kv-row')).toHaveCount(2);
  await headers.locator('.kv-row').nth(0).locator('.kv-key').fill('X-Trace');
  await headers.locator('.kv-row').nth(0).locator('.kv-val').fill('abc');
  await expect(headers.locator('.kv-row').nth(0).locator('.kv-key')).toHaveValue('X-Trace');
});

test('an invalid JSON object field is rejected inline as you type', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/inspector-json/edit');
  await addStep(page, /HTTP API/);
  await page.locator('.metis-node').first().click();
  const inspector = page.locator('.inspector');
  await inspector.locator('.disclosure > summary').click();
  // auth is a plain object field, so it edits as JSON.
  await inspector.locator('[data-field="auth"] textarea').fill('{not json');
  await expect(inspector.locator('[data-field="auth"] .field-error')).toHaveText('must be valid JSON');
});

test('the tabs are a keyboard-operable tablist', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/inspector-tabs/edit');
  await addStep(page, /HTTP API/);
  await page.locator('.metis-node').first().click();
  const inspector = page.locator('.inspector');

  const setup = inspector.getByRole('tab', { name: 'Setup' });
  await setup.focus();
  await expect(setup).toHaveAttribute('aria-selected', 'true');
  // The HTTP API node carries docs, so Guide sits between Setup and Test.
  await page.keyboard.press('ArrowRight');
  await expect(inspector.getByRole('tab', { name: 'Guide' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(inspector.getByRole('tab', { name: 'Test' })).toHaveAttribute('aria-selected', 'true');
  await expect(inspector.getByRole('tab', { name: 'Setup' })).toHaveAttribute('aria-selected', 'false');
});

test('the palette lists node types, not a connector; a bound node picks a connection', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/inspector-connector-scope/edit');
  const inspector = page.locator('.inspector');

  // `connector` is not-a-node: the library offers node TYPES, never a Connector node.
  await page.getByRole('button', { name: 'Add step' }).click();
  await expect(page.locator('.library').getByRole('button', { name: /^Connector$/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // A SendGrid step's provider is fixed by the node type; its inspector shows a
  // CONNECTION selector (pick one or create a new named one) - not a
  // connector-type picker, and no category narrower.
  await addStep(page, /SendGrid/);
  await page.locator('.metis-node').first().click();
  const picker = inspector.locator('.connector-picker');
  await expect(picker.locator('#conn-conn')).toBeVisible();
  await expect(picker.getByRole('button', { name: '+ New connection' })).toBeVisible();
  await expect(picker.locator('#conn-id')).toHaveCount(0);
  await expect(picker.locator('#conn-cat')).toHaveCount(0);
});

test('a wired-connector node is a bespoke step: operation enum + a connection', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/inspector-github/edit');
  const inspector = page.locator('.inspector');

  // GitHub is a droppable node type generated from the connector catalogue.
  await addStep(page, /GitHub/);
  await page.locator('.metis-node').first().click();

  // Its operations come from the connector (getRepo / listIssues / createIssue).
  const op = inspector.locator('[data-field="operation"] select');
  await expect(op).toBeVisible();
  await expect(op.locator('option', { hasText: 'getRepo' })).toHaveCount(1);
  await expect(op.locator('option', { hasText: 'createIssue' })).toHaveCount(1);

  // And a connection (the connectorRef picker, scoped to github) for auth only.
  const picker = inspector.locator('.connector-picker');
  await expect(picker.locator('#conn-conn')).toBeVisible();
  await expect(picker.getByRole('button', { name: '+ New connection' })).toBeVisible();
});

test('a connector node renders a field per operation parameter', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/inspector-op-params/edit');
  const inspector = page.locator('.inspector');
  await addStep(page, /GitHub/);
  await page.locator('.metis-node').first().click();

  // getRepo's path is /repos/{owner}/{repo}, so choosing it reveals owner + repo.
  await inspector.locator('[data-field="operation"] select').selectOption('getRepo');
  await expect(inspector.locator('[data-field="param-owner"] input')).toBeVisible();
  await expect(inspector.locator('[data-field="param-repo"] input')).toBeVisible();
  await inspector.locator('[data-field="param-owner"] input').fill('seillen');
  await inspector.locator('[data-field="param-repo"] input').fill('metis');

  // Extra query/body params can be added as key/value rows.
  await inspector.locator('.op-extra').getByRole('button', { name: 'Add parameter' }).click();
  await expect(inspector.locator('.op-extra .kv-row')).toHaveCount(1);

  // Switching operations reshapes the fields (createIssue keeps owner/repo).
  await inspector.locator('[data-field="operation"] select').selectOption('createIssue');
  await expect(inspector.locator('[data-field="param-owner"] input')).toHaveValue('seillen');
});

test('a connection is created + tested in a modal, then tested from the inspector', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/inspector-database/edit');
  const inspector = page.locator('.inspector');

  await addStep(page, /^Data/);
  await page.locator('.metis-node').first().click();
  const picker = inspector.locator('.connector-picker');
  await expect(picker.locator('#conn-conn')).toBeVisible();

  // "+ New connection" opens a MODAL (more surface area) with the database form
  // and a Test button.
  await picker.getByRole('button', { name: '+ New connection' }).click();
  const modal = page.locator('.modal');
  await expect(modal).toBeVisible();
  await expect(modal.locator('#cred-host')).toBeVisible();
  await expect(modal.locator('#cred-password')).toHaveAttribute('type', 'password');
  await modal.locator('#conn-name').fill('Local PG');
  await modal.locator('#cred-host').fill('127.0.0.1');
  await modal.locator('#cred-port').fill('1');
  await modal.locator('#cred-database').fill('metis');
  await modal.locator('#cred-user').fill('metis');
  await modal.locator('#cred-password').fill('metis');

  // Test inside the modal before committing (closed port -> not working).
  await modal.getByRole('button', { name: 'Test connection' }).click();
  await expect(modal.locator('.conn-badge')).toHaveText(/Unreachable|Error|Auth failed/, {
    timeout: 15000,
  });

  // Create + use it; the modal closes and the connection is selected.
  await modal.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(picker.locator('#conn-conn')).toHaveValue(/conn_/);

  // The selected connection can also be tested from the inspector.
  await picker.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(picker.locator('.conn-badge')).toHaveText(/Unreachable|Error|Auth failed/, {
    timeout: 15000,
  });
});

test('the inspector is always the wide panel (no user/developer mode)', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/inspector-modes/edit');
  await addStep(page, /HTTP API/);
  await page.locator('.metis-node').first().click();

  const inspector = page.locator('.inspector');
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveClass(/inspector-wide/);
  await expect(inspector.locator('[data-field="url"] input')).toBeVisible();
  // The user/developer toggle is gone.
  await expect(page.getByRole('button', { name: 'Developer', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'User', exact: true })).toHaveCount(0);
});

test('removing a step asks for confirmation; cancel keeps it', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/inspector-remove/edit');
  await addStep(page, /HTTP API/);
  await page.locator('.metis-node').first().click();
  const inspector = page.locator('.inspector');

  // Cancel keeps the node on the canvas.
  await inspector.getByRole('button', { name: 'Remove step' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.metis-node')).toHaveCount(1);

  // Confirm removes it and announces it.
  await inspector.getByRole('button', { name: 'Remove step' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.metis-node')).toHaveCount(0);
  await expect(page.locator('.toast-info', { hasText: 'Step removed' })).toBeVisible();
});

test('a schema with no required fields renders everything up front (no disclosure)', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/inspector-disclosure-edge/edit');
  await addStep(page, /Wait Until/);
  await page.locator('.metis-node').first().click();
  const configure = page.locator('.inspector .ins-region[aria-label="Configure"]');

  // Wait Until declares no required fields: all of them are primary, none
  // hide behind "Show advanced".
  await expect(configure.locator('[data-field="waitMinutes"] input')).toBeVisible();
  await expect(configure.locator('[data-field="dateFrom"] input')).toBeVisible();
  await expect(configure.locator('.disclosure')).toHaveCount(0);
});

test('the Test tab runs this step alone and shows its output', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/inspector-test-run/edit');
  await addStep(page, /^Code/);
  await page.locator('.metis-node').first().click();
  const inspector = page.locator('.inspector');

  await inspector.getByRole('tab', { name: 'Test' }).click();
  await inspector.locator('#test-input').fill('{"who":"metis"}');
  await inspector.getByRole('button', { name: 'Test this step' }).click();

  await expect(inspector.locator('.test-status')).toContainText(/Run (completed|running)/);
  await expect(inspector.locator('.test-result-label')).toHaveText('This step returned', {
    timeout: 15000,
  });
  await expect(inspector.locator('.test-output')).toContainText('"simulated": true');
});

test('the Test tab surfaces a failing step with its error', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/inspector-test-fail/edit');
  await addStep(page, /^Code/);
  await page.locator('.metis-node').first().click();
  const inspector = page.locator('.inspector');

  // The harness engine fails any step named "Fail me".
  await inspector.getByLabel('Step name').fill('Fail me');
  await inspector.getByRole('tab', { name: 'Test' }).click();
  await inspector.getByRole('button', { name: 'Test this step' }).click();

  await expect(inspector.locator('.test-result-label')).toHaveText('This step failed', {
    timeout: 15000,
  });
  await expect(inspector.locator('.test-output-error')).toContainText('simulated failure');
});

test('the History tab lists runs and expands to this step logs', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/inspector-history-tab/edit');
  await addStep(page, /^Code/);
  await page.locator('.metis-node').first().click();
  const inspector = page.locator('.inspector');

  // Produce one run through the Test tab, then read it back in History.
  await inspector.getByRole('tab', { name: 'Test' }).click();
  await inspector.getByRole('button', { name: 'Test this step' }).click();
  await expect(inspector.locator('.test-result-label')).toBeVisible({ timeout: 15000 });

  await inspector.getByRole('tab', { name: 'History' }).click();
  const row = inspector.locator('.hist-row').first();
  await expect(row.locator('.hist-status')).toHaveText('completed');
  await row.locator('.hist-head').click();
  await expect(row.locator('.hist-event')).toHaveText('completed');
  await expect(row.locator('.hist-output')).toContainText('"simulated": true');
});

test('the Policy tab round-trips through save and reload', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/inspector-policy-trip/edit');
  await addStep(page, /HTTP API/);
  await page.locator('.metis-node').first().click();
  const inspector = page.locator('.inspector');

  await inspector.getByRole('tab', { name: 'Policy' }).click();
  await inspector.locator('#policy-retries').fill('3');
  await inspector.locator('#policy-timeout').fill('30');
  await inspector.getByRole('button', { name: 'Carry on' }).click();
  await inspector.locator('.ins-foot .btn-primary').click();
  await expect(page).toHaveURL(/\/workflows\/wf_[^/]+\/edit/);

  await page.reload();
  await page.locator('.metis-node').first().click();
  await inspector.getByRole('tab', { name: 'Policy' }).click();
  await expect(inspector.locator('#policy-retries')).toHaveValue('3');
  await expect(inspector.locator('#policy-timeout')).toHaveValue('30');
  await expect(inspector.getByRole('button', { name: 'Carry on' })).toHaveAttribute('aria-pressed', 'true');
});
