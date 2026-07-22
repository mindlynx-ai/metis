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
 * A2: declaring a trigger's outputs from a pasted sample request. On a webhook
 * node, paste an example body; its keys (prefixed body.) become the step's
 * declared outputs, persist through a save/reload, and surface downstream as
 * inputs the next step can use.
 */
import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers.js';

const seedWebhookWorkflow = (page: Page) =>
  page.evaluate(async () => {
    const token = localStorage.getItem('metis-token');
    const res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Webhook sample',
        nodes: [
          {
            id: 'hook',
            type: 'webhookconfig',
            version: 'v1',
            data: { label: 'Webhook', config: { triggerType: 'webhook', path: 'orders' } },
          },
          {
            id: 'step',
            type: 'code',
            version: 'v1',
            data: { label: 'Code', config: { code: 'return input;' } },
          },
        ],
        edges: [{ id: 'e', source: 'hook', target: 'step', sourceHandle: null }],
      }),
    });
    return (await res.json()) as { id: string };
  });

test('a pasted sample declares trigger outputs that persist and flow downstream', async ({
  page,
}) => {
  await login(page);
  const { id } = await seedWebhookWorkflow(page);
  await page.goto(`http://127.0.0.1:4180/workflows/${id}/edit`);

  // Select the webhook trigger; its "Passes on" region offers the sample paste.
  await page.locator('.metis-node').first().click();
  const inspector = page.locator('.inspector');
  const sample = inspector.locator('[data-testid="sample-request"]');
  await expect(sample).toBeVisible();

  // Paste an example body and adopt the detected fields.
  await sample.getByLabel('Example body (JSON)').fill('{"firstName":"Ada","lastName":"L"}');
  await expect(sample.locator('.sample-preview')).toContainText('body.firstName');
  await sample.getByRole('button', { name: 'Use these fields' }).click();
  await expect(inspector.locator('[data-testid="sample-applied"]')).toContainText('body.firstName');

  // Save round-trips to the new id; reload proves the declaration persisted.
  await inspector.locator('.ins-foot .btn-primary').click();
  await expect(page).toHaveURL(/\/workflows\/wf_[^/]+\/edit/);
  await page.reload();
  await page.locator('.metis-node').first().click();
  await expect(inspector.locator('[data-testid="sample-applied"]')).toContainText('body.firstName');
  await expect(inspector.locator('[data-testid="sample-applied"]')).toContainText('body.lastName');

  // Downstream the code step now sees those fields as inputs it can use.
  await page.locator('.metis-node').nth(1).click();
  await expect(inspector.locator('.io-region').first()).toContainText('body.firstName');
});

test('invalid JSON shows an inline error and declares nothing', async ({ page }) => {
  await login(page);
  const { id } = await seedWebhookWorkflow(page);
  await page.goto(`http://127.0.0.1:4180/workflows/${id}/edit`);
  await page.locator('.metis-node').first().click();
  const sample = page.locator('[data-testid="sample-request"]');
  await sample.getByLabel('Example body (JSON)').fill('{not json');
  await expect(sample.getByRole('alert')).toContainText(/valid JSON/i);
  await expect(sample.getByRole('button', { name: 'Use these fields' })).toBeDisabled();
});
