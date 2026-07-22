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
 * A3: the variable picker. Upstream steps offer their fields as chips in the
 * "What it receives" region; clicking a chip drops the canonical
 * {{node-<id>.data.<key>}} reference into the config field you were editing.
 * Chips are scoped to actual ancestors, and the inserted reference persists.
 */
import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers.js';

const seed = (page: Page) =>
  page.evaluate(async () => {
    const token = localStorage.getItem('metis-token');
    const res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Variables',
        nodes: [
          {
            id: 'hook',
            type: 'webhookconfig',
            version: 'v1',
            data: {
              label: 'Webhook',
              config: { triggerType: 'webhook', path: 'x' },
              // Declared outputs from a prior sample (A2), so the picker offers them.
              outputs: [{ manualData: [{ key: 'body.firstName', type: 'string' }] }],
            },
          },
          {
            id: 'call',
            type: 'api',
            version: 'v1',
            data: { label: 'Call', config: { method: 'POST' } },
          },
        ],
        edges: [{ id: 'e', source: 'hook', target: 'call', sourceHandle: null }],
      }),
    });
    return (await res.json()) as { id: string };
  });

test('clicking an upstream chip inserts its reference into the focused field', async ({ page }) => {
  await login(page);
  const { id } = await seed(page);
  await page.goto(`http://127.0.0.1:4180/workflows/${id}/edit`);

  // Configure the API step; the webhook's declared field is offered as a chip.
  await page.locator('.metis-node').nth(1).click();
  const inspector = page.locator('.inspector');
  const palette = inspector.locator('.var-palette');
  await expect(palette).toContainText('body.firstName');

  // Focus the URL field, then click the chip: the reference lands at the cursor.
  const url = inspector.locator('[data-field="url"] input');
  await url.fill('https://api.test/users/');
  await url.focus();
  await palette.getByRole('button', { name: /body\.firstName/ }).click();
  await expect(url).toHaveValue('https://api.test/users/{{hook.data.body.firstName}}');

  // It survives a save + reload (persisted into the node config).
  await inspector.locator('.ins-foot .btn-primary').click();
  await expect(page).toHaveURL(/\/workflows\/wf_[^/]+\/edit/);
  await page.reload();
  await page.locator('.metis-node').nth(1).click();
  await expect(inspector.locator('[data-field="url"] input')).toHaveValue(
    'https://api.test/users/{{hook.data.body.firstName}}',
  );
});

test('an api response mapping is authored with the picker and persists runnably', async ({
  page,
}) => {
  await login(page);
  const created = await page.evaluate(async () => {
    const token = localStorage.getItem('metis-token');
    const res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Greet API',
        nodes: [
          {
            id: 'start',
            type: 'apiconfig',
            version: 'v1',
            data: {
              label: 'API Start',
              config: { path: 'greet', method: 'POST' },
              outputs: [{ manualData: [{ key: 'firstName', type: 'string' }] }],
            },
          },
          {
            id: 'end',
            type: 'apiend',
            version: 'v1',
            data: { label: 'API End', config: { responseType: 'mappeddata', statusCode: 200 } },
          },
        ],
        edges: [{ id: 'e', source: 'start', target: 'end', sourceHandle: null }],
      }),
    });
    return (await res.json()) as { id: string };
  });
  await page.goto(`http://127.0.0.1:4180/workflows/${created.id}/edit`);

  // On API End, author the mapped response by inserting the Start's field.
  await page.locator('.metis-node', { hasText: 'API End' }).click();
  const inspector = page.locator('.inspector');
  const mapping = inspector.locator('[data-field="responseMapping"] textarea');
  await mapping.fill('{"greeting":"Hello "}');
  // Cursor just before the closing quote+brace so the reference lands inside.
  await mapping.focus();
  await mapping.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(19, 19));
  await inspector.locator('.var-palette').getByRole('button', { name: /firstName/ }).click();
  await expect(mapping).toHaveValue('{"greeting":"Hello {{start.data.firstName}}"}');

  // Persist and prove the runnable reference survived the round-trip.
  await inspector.locator('.ins-foot .btn-primary').click();
  await expect(page).toHaveURL(/\/workflows\/wf_[^/]+\/edit/);
  const saved = await page.evaluate(async () => {
    const token = localStorage.getItem('metis-token');
    const id = location.pathname.split('/')[2];
    const res = await fetch(`/api/workflows/${id}`, { headers: { authorization: `Bearer ${token}` } });
    return (await res.json()) as { nodes: { type: string; data: { config: Record<string, unknown> } }[] };
  });
  const end = saved.nodes.find((n) => n.type === 'apiend');
  expect(end?.data.config.responseMapping).toEqual({ greeting: 'Hello {{start.data.firstName}}' });
});

test('the picker offers ancestors only, not sibling branches', async ({ page }) => {
  await login(page);
  const created = await page.evaluate(async () => {
    const token = localStorage.getItem('metis-token');
    const res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Branches',
        nodes: [
          { id: 'hook', type: 'webhookconfig', version: 'v1', data: { label: 'Webhook', config: { triggerType: 'webhook', path: 'y' } } },
          { id: 'left', type: 'api', version: 'v1', data: { label: 'Left call', config: { method: 'GET' } } },
          { id: 'right', type: 'api', version: 'v1', data: { label: 'Right call', config: { method: 'GET' } } },
        ],
        edges: [
          { id: 'e1', source: 'hook', target: 'left', sourceHandle: null },
          { id: 'e2', source: 'hook', target: 'right', sourceHandle: null },
        ],
      }),
    });
    return (await res.json()) as { id: string };
  });
  await page.goto(`http://127.0.0.1:4180/workflows/${created.id}/edit`);

  // Configuring "Right call": it sees the webhook (its ancestor) but never "Left call".
  await page.locator('.metis-node', { hasText: 'Right call' }).click();
  const palette = page.locator('.inspector .var-palette');
  await expect(palette).toContainText('Webhook');
  await expect(palette).not.toContainText('Left call');
});
