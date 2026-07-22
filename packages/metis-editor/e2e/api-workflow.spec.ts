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
 * API Start / API End end to end: a graph with an API Start is an api-type
 * workflow (inferred on save), the builder offers "Publish API" (not Run) and
 * announces the callable URL, and a request to /api/apiworkflow/<path> runs it
 * and gets a response straight back. The dev harness simulates the engine, so
 * this proves the HTTP wiring + UI; the real engine round-trip is proven live.
 * (Canvas drag-to-connect is covered by canvas.spec, so the graph is seeded
 * via the API here to keep the test on the api-workflow behaviour.)
 */
import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers.js';

const seedApiWorkflow = (page: Page, path: string) =>
  page.evaluate(async (endpointPath) => {
    const token = localStorage.getItem('metis-token');
    const res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `API ${endpointPath}`,
        nodes: [
          {
            id: 'start',
            type: 'apiconfig',
            version: 'v1',
            data: { label: 'API Start', config: { path: endpointPath, method: 'POST' } },
          },
          {
            id: 'end',
            type: 'apiend',
            version: 'v1',
            data: { label: 'API End', config: { responseType: 'sourcedata', statusCode: 201 } },
          },
        ],
        edges: [{ id: 'e', source: 'start', target: 'end', sourceHandle: null }],
      }),
    });
    return (await res.json()) as { id: string };
  }, path);

const callEndpoint = (page: Page, path: string, body: unknown) =>
  page.evaluate(
    async ({ endpointPath, payload }) => {
      const token = localStorage.getItem('metis-token');
      const res = await fetch(`/api/apiworkflow/${endpointPath}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: await res.json() };
    },
    { endpointPath: path, payload: body },
  );

test('an API Start workflow shows Publish API and becomes a callable endpoint', async ({ page }) => {
  await login(page);
  const { id } = await seedApiWorkflow(page, 'orders');

  // The builder recognises the api graph: the primary action is Publish API.
  await page.goto(`http://127.0.0.1:4180/workflows/${id}/edit`);
  const publish = page.getByRole('button', { name: 'Publish API' });
  await expect(publish).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);

  // Publishing announces the callable URL.
  await publish.click();
  await expect(
    page.locator('.toast-success', { hasText: '/api/apiworkflow/orders' }),
  ).toBeVisible();

  // The endpoint runs synchronously and returns apiend's body + status.
  const result = await callEndpoint(page, 'orders', { name: 'Ada' });
  expect(result.status).toBe(201);
  expect(result.body).toEqual({ ok: true, received: { name: 'Ada' } });
});

test('an unknown api path returns 404', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/');
  const result = await callEndpoint(page, 'does-not-exist', {});
  expect(result.status).toBe(404);
});
