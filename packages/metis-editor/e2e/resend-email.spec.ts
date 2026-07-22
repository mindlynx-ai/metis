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
 * The email node type (Resend): its inspector must show the parameters an email
 * needs - From, To, Subject, Body - as typed labelled fields, not a blank
 * key/value editor. This is the "what you receive" half of the node, and it must
 * round-trip through a save/reload.
 */
import { test, expect, type Page } from '@playwright/test';
import { login, addStep } from './helpers.js';

const seed = (page: Page, nodes: unknown[], edges: unknown[]) =>
  page.evaluate(
    async ({ n, e }) => {
      const token = localStorage.getItem('metis-token');
      const res = await fetch('/api/workflows', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Email flow', nodes: n, edges: e }),
      });
      return (await res.json()) as { id: string };
    },
    { n: nodes, e: edges },
  );

test('a Resend node shows typed From / To / Subject / Body fields and persists them', async ({
  page,
}) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/resend-check/edit');

  await addStep(page, /^Resend/);
  await page.locator('.metis-node').first().click();
  const inspector = page.locator('.inspector');
  await expect(inspector).toBeVisible();

  // Choose the sendEmail operation.
  await inspector.locator('[data-field="operation"] select').selectOption('sendEmail');

  // The email fields render as labelled, typed inputs - not a blank KV editor.
  await expect(inspector.locator('[data-field="param-from"] label')).toContainText('From');
  await expect(inspector.locator('[data-field="param-to"] label')).toContainText('To');
  await expect(inspector.locator('[data-field="param-subject"] label')).toContainText('Subject');
  await expect(inspector.locator('[data-field="param-html"] label')).toContainText('Body');
  // The body is a textarea (type: text); the rest are single-line inputs.
  await expect(inspector.locator('[data-field="param-html"] textarea')).toBeVisible();
  await expect(inspector.locator('[data-field="param-to"] input')).toBeVisible();

  // Fill the email and persist it.
  await inspector.locator('[data-field="param-from"] input').fill('you@demo.com');
  await inspector.locator('[data-field="param-to"] input').fill('lisa@demo.com');
  await inspector.locator('[data-field="param-subject"] input').fill('Welcome');
  await inspector.locator('[data-field="param-html"] textarea').fill('<p>Hi Lisa</p>');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('.toast-success')).toBeVisible();

  // Reload: the node kept its email parameters.
  await page.reload();
  await page.locator('.metis-node').first().click();
  await expect(inspector.locator('[data-field="param-to"] input')).toHaveValue('lisa@demo.com');
  await expect(inspector.locator('[data-field="param-subject"] input')).toHaveValue('Welcome');
  await expect(inspector.locator('[data-field="param-html"] textarea')).toHaveValue('<p>Hi Lisa</p>');
});

test('the Test tab shows the email step JSON and tests just that step', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/resend-test-tab/edit');
  await addStep(page, /^Resend/);
  await page.locator('.metis-node').first().click();
  const inspector = page.locator('.inspector');
  await inspector.locator('[data-field="operation"] select').selectOption('sendEmail');
  await inspector.locator('[data-field="param-from"] input').fill('you@demo.com');
  await inspector.locator('[data-field="param-to"] input').fill('lisa@demo.com');
  await inspector.locator('[data-field="param-subject"] input').fill('Welcome');

  await inspector.getByRole('tab', { name: 'Test' }).click();
  // The JSON of what this step will send is visible and reflects the fields.
  const sends = inspector.locator('[data-testid="test-sends"]');
  await expect(sends).toContainText('you@demo.com');
  await expect(sends).toContainText('lisa@demo.com');
  await expect(sends).toContainText('Welcome');
  // Testing runs this step alone (the button is scoped to the step).
  await expect(inspector.getByRole('button', { name: 'Test this step' })).toBeVisible();
});

test('choosing sendEmail declares what the node gives (the email id), and it persists', async ({
  page,
}) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/resend-out/edit');
  await addStep(page, /^Resend/);
  await page.locator('.metis-node').first().click();
  const inspector = page.locator('.inspector');
  await inspector.locator('[data-field="operation"] select').selectOption('sendEmail');

  // "Passes on" (the what-it-gives panel) offers the email id as a reference.
  await inspector.locator('.io-region summary', { hasText: 'Passes on' }).click();
  const idChip = inspector.getByRole('button', { name: /Copy reference .*\.data\.id/ });
  await expect(idChip).toBeVisible();

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('.toast-success')).toBeVisible();
  await page.reload();
  await page.locator('.metis-node').first().click();
  await inspector.locator('.io-region summary', { hasText: 'Passes on' }).click();
  await expect(inspector.getByRole('button', { name: /Copy reference .*\.data\.id/ })).toBeVisible();
});

test('the email id is offered to a downstream step as a variable', async ({ page }) => {
  await login(page);
  const { id } = await seed(
    page,
    [
      {
        id: 'mail',
        type: 'resend',
        version: 'v1',
        position: { x: 80, y: 140 },
        data: {
          label: 'Send welcome',
          config: { operation: 'sendEmail' },
          outputs: [{ manualData: [{ key: 'id', type: 'string', value: '' }] }],
        },
      },
      { id: 'call', type: 'api', version: 'v1', position: { x: 440, y: 140 }, data: { label: 'Notify', config: {} } },
    ],
    [{ id: 'e', source: 'mail', target: 'call', sourceHandle: null }],
  );
  await page.goto(`http://127.0.0.1:4180/workflows/${id}/edit`);

  await page.locator('.metis-node', { hasText: 'Notify' }).click();
  const inspector = page.locator('.inspector');
  const url = inspector.locator('[data-field="url"] input');
  await url.click();
  const palette = inspector.locator('.var-palette');
  await expect(palette).toBeVisible();
  // The upstream email node offers its id; inserting it writes the canonical ref.
  await palette.getByRole('button', { name: 'Insert Send welcome id' }).click();
  await expect(url).toHaveValue(/\{\{mail\.data\.id\}\}/);
});
