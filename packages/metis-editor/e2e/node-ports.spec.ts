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
 * Node ports and the inline add affordance: a logic node branches Yes/No (two
 * output handles), the hover "+" adds and connects the next step, and a newly
 * added node always lands where the user can see it - never off-screen.
 */
import { test, expect, type Page } from '@playwright/test';
import { login, addStep } from './helpers.js';

const seed = (page: Page, nodes: unknown[], edges: unknown[] = []) =>
  page.evaluate(
    async ({ n, e }) => {
      const token = localStorage.getItem('metis-token');
      const res = await fetch('/api/workflows', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ports', nodes: n, edges: e }),
      });
      return (await res.json()) as { id: string };
    },
    { n: nodes, e: edges },
  );

test('a logic node branches Yes/No with two output ports', async ({ page }) => {
  await login(page);
  const { id } = await seed(page, [
    { id: 'b', type: 'logic', version: 'v1', position: { x: 200, y: 200 }, data: { label: 'Branch', config: {} } },
  ]);
  await page.goto(`http://127.0.0.1:4180/workflows/${id}/edit`);
  const branch = page.locator('.metis-node', { hasText: 'Branch' });
  // A logic node routes true/false; the canvas labels them Yes/No.
  await expect(branch.locator('.react-flow__handle-right')).toHaveCount(2);
  await expect(branch.locator('.react-flow__handle[data-handleid="true"]')).toHaveCount(1);
  await expect(branch.locator('.fnode-port-label')).toHaveText(['Yes', 'No']);
});

test('the hover "+" adds and connects the next step', async ({ page }) => {
  await login(page);
  const { id } = await seed(page, [
    { id: 'a', type: 'webhookconfig', version: 'v1', position: { x: 120, y: 200 }, data: { label: 'Hook', config: {} } },
  ]);
  await page.goto(`http://127.0.0.1:4180/workflows/${id}/edit`);
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);

  // The "+" opens the library scoped to "the next step" and connects it.
  await page.locator('.metis-node').first().hover();
  await page.locator('.fnode-plus').click();
  await expect(page.locator('.library h2')).toHaveText('Add the next step');
  await page.locator('.library').getByRole('button', { name: /HTTP API/ }).first().click();

  await expect(page.locator('.metis-node')).toHaveCount(2);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
});

test('a newly added step lands on-screen, not off in the void', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/onscreen-check/edit');
  await addStep(page, /Webhook Start/);

  const canvas = await page.locator('.builder-canvas').boundingBox();
  const node = await page.locator('.metis-node').first().boundingBox();
  expect(canvas).not.toBeNull();
  expect(node).not.toBeNull();
  // The node's box sits inside the visible canvas rectangle.
  expect(node!.x).toBeGreaterThanOrEqual(canvas!.x - 1);
  expect(node!.y).toBeGreaterThanOrEqual(canvas!.y - 1);
  expect(node!.x + node!.width).toBeLessThanOrEqual(canvas!.x + canvas!.width + 1);
  expect(node!.y + node!.height).toBeLessThanOrEqual(canvas!.y + canvas!.height + 1);
});
