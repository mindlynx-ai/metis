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
 * The SQL transform node: a distinct step that runs a SQL query on a Postgres
 * connection. Its inspector is a connection picker plus a SQL editor, and the
 * query round-trips a save/reload. (The live run against a real database is
 * proven against the sample-db compose overlay, not the dev harness.)
 */
import { test, expect } from '@playwright/test';
import { login, addStep } from './helpers.js';

test('the Data node has a connection picker and a SQL editor that persists', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/data-check/edit');

  await addStep(page, /^Data/);
  await page.locator('.metis-node').first().click();
  const inspector = page.locator('.inspector');

  // A connection field (scoped to a data source) and a SQL query editor.
  await expect(inspector.getByText('Connection', { exact: true })).toBeVisible();
  const query = inspector.locator('[data-field="dataBuilder"] textarea');
  await expect(query).toBeVisible();

  await query.fill('select id, customer, amount from orders order by amount desc');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('.toast-success')).toBeVisible();

  await page.reload();
  await page.locator('.metis-node').first().click();
  await expect(inspector.locator('[data-field="dataBuilder"] textarea')).toHaveValue(
    'select id, customer, amount from orders order by amount desc',
  );
});

test('the Data node builds a query visually (no SQL) and it persists', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/data-build/edit');

  await addStep(page, /^Data/);
  await page.locator('.metis-node').first().click();
  const inspector = page.locator('.inspector');

  // Switch from SQL to the visual builder; with no live database the table
  // falls back to a typed name.
  await inspector.getByRole('tab', { name: 'Build a query' }).click();
  await inspector.locator('#data-op').selectOption('select');
  await inspector.locator('#data-table').fill('orders');
  await inspector.getByRole('button', { name: 'Add a filter' }).click();
  const row = inspector.locator('.kv-row').first();
  await row.locator('.kv-key').fill('status');
  await row.locator('.kv-op').selectOption('=');
  await row.locator('.kv-val').fill('paid');

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('.toast-success')).toBeVisible();

  await page.reload();
  await page.locator('.metis-node').first().click();
  // Reopens in Build mode with the table + filter intact.
  await expect(inspector.locator('#data-table')).toHaveValue('orders');
  await expect(inspector.locator('.kv-row .kv-key').first()).toHaveValue('status');
});

/**
 * The engine has to be RECORDED, not guessed. Picking a connection is the only
 * moment anything knows which system it is, and the saved step is what the
 * cloud-bind guard later reads: without the engine beside the connection id,
 * a step aimed at this database cannot be told apart from one aimed at the
 * cloud warehouse, and its SQL runs against the wrong data with a 200.
 *
 * Asserted on the save payload the app actually sends, because a hand-built
 * config can declare an engine that no real node carries.
 */
test('picking a database connection saves the engine beside the connection id', async ({ page }) => {
  await login(page);

  // A real connection, made the way a user makes one.
  await page.goto('http://127.0.0.1:4180/connectors');
  await page.locator('.conn-connect-btn').click();
  const modal = page.locator('.modal');
  await modal.getByRole('tab', { name: 'Database' }).click();
  await modal.locator('#add-name').fill('Own Postgres');
  await modal.locator('#add-engine').selectOption('postgres');
  await modal.locator('#add-host').fill('127.0.0.1');
  await modal.locator('#add-port').fill('1');
  await modal.locator('#add-database').fill('metis');
  await modal.locator('#add-user').fill('metis');
  await modal.locator('#add-password').fill('metis');
  await modal.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.conn-card', { hasText: 'Own Postgres' })).toHaveCount(1);

  await page.goto('http://127.0.0.1:4180/workflows/data-engine/edit');
  await addStep(page, /^Data/);
  await page.locator('.metis-node').first().click();

  const picker = page.locator('.inspector .connector-picker #conn-conn');
  await picker.selectOption({ label: 'Own Postgres' });
  const connectionId = await picker.inputValue();
  expect(connectionId).not.toBe('');

  const saved = page.waitForRequest(
    (request) => request.url().includes('/api/workflows') && ['POST', 'PATCH'].includes(request.method()),
  );
  await page.getByRole('button', { name: 'Save draft' }).click();
  const body = JSON.parse((await saved).postData() ?? '{}') as {
    nodes?: { type: string; data?: { config?: Record<string, unknown> } }[];
  };

  const config = (body.nodes ?? []).find((node) => node.type === 'data')?.data?.config ?? {};
  expect(config.connectorId).toBe(connectionId);
  expect(config.engine).toBe('postgres');
});

test('the one Data node is found by "sql", "data" or "query" (postgres/sql demoted)', async ({
  page,
}) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/data-search/edit');
  await page.getByRole('button', { name: 'Add step' }).click();
  const lib = page.locator('.library');
  for (const term of ['sql', 'data', 'query']) {
    await lib.getByLabel('Find a step').fill(term);
    await expect(lib.locator('.lib-name').filter({ hasText: /^Data$/ })).toHaveCount(1);
    await expect(lib.locator('.lib-name').filter({ hasText: /^SQL$/ })).toHaveCount(0);
  }
});
