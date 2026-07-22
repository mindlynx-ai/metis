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
 * B3: the workflows list. Each workflow is a card - a mini node-chain preview,
 * name + status, step count - that opens the builder, with Runs and Delete
 * actions alongside.
 */
import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers.js';

const seed = (page: Page, name: string) =>
  page.evaluate(async (workflowName) => {
    const token = localStorage.getItem('metis-token');
    const res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: workflowName,
        nodes: [
          { id: 'a', type: 'webhookconfig', version: 'v1', data: { label: 'Webhook', config: {} } },
          { id: 'b', type: 'code', version: 'v1', data: { label: 'Code', config: {} } },
          { id: 'c', type: 'api', version: 'v1', data: { label: 'API', config: {} } },
        ],
        edges: [
          { id: 'e1', source: 'a', target: 'b', sourceHandle: null },
          { id: 'e2', source: 'b', target: 'c', sourceHandle: null },
        ],
      }),
    });
    return (await res.json()) as { id: string };
  }, name);

test('a workflow renders as a card with its chain, status and step count', async ({ page }) => {
  await login(page);
  const name = `List card ${Date.now()}`;
  await seed(page, name);
  await page.goto('http://127.0.0.1:4180/workflows');

  const card = page.locator('.wf-card', { hasText: name });
  await expect(card).toBeVisible();
  await expect(card.locator('.wf-meta')).toContainText('3 steps');
  // Three steps -> three category-tinted chain chips.
  await expect(card.locator('.chain-chip')).toHaveCount(3);
  await expect(card.locator('.status')).toHaveText('draft');
});

test('the card opens the builder and offers Runs + Delete', async ({ page }) => {
  await login(page);
  const name = `List actions ${Date.now()}`;
  await seed(page, name);
  await page.goto('http://127.0.0.1:4180/workflows');
  const card = page.locator('.wf-card', { hasText: name });

  await expect(card.getByRole('link', { name: 'Runs' })).toBeVisible();
  // Deleting asks for confirmation (the modal's own confirm button), then the
  // card leaves the list.
  await card.getByRole('button', { name: 'Delete' }).click();
  await page.locator('.btn-danger').getByText('Delete', { exact: true }).click();
  await expect(page.locator('.wf-card', { hasText: name })).toHaveCount(0);
});
