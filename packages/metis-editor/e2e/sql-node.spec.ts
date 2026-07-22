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
