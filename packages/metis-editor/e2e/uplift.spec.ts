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
 * The uplift surfaces, end to end against the in-repo Helix stub
 * (dev-core starts it on :4182): the three palette states, the consent
 * gate and its receipt, "Where it runs", the /account page with the
 * OIDC connect round-trip, the degraded treatment, and the offline
 * static fallback. Fidelity screenshots (both themes, macOS baselines)
 * hold the build to the signed-off prototypes.
 *
 * Serial on purpose: the connect and stub-toggle tests mutate shared
 * server state that the earlier assertions depend on being clean.
 */
import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { login, addStep } from './helpers.js';

test.describe.configure({ mode: 'serial' });

const THEMES = ['light', 'dark'] as const;
const mac = process.platform === 'darwin';

const setTheme = async (page: Page, theme: 'light' | 'dark') => {
  await page.addInitScript((wanted) => localStorage.setItem('metis-theme', wanted), theme);
};

const settle = async (page: Page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
};

/** Switch the workflow's "Allow cloud" toggle on through the bar button. */
const enableWorkflowCloud = async (page: Page) => {
  await page.getByRole('button', { name: 'Cloud for this workflow' }).click();
  const modal = page.getByRole('dialog', { name: 'Cloud for this workflow' });
  await modal.locator('.switch-row').click();
  await expect(modal.locator('.switch-row input')).toBeChecked();
  await modal.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.b-cloud.on')).toBeVisible();
};

const noBlockingViolations = async (page: Page, include?: string) => {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const blocking = results.violations.filter(
    (violation: { impact?: string | null }) =>
      violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    blocking.map((violation: { id: string; help: string }) => `${violation.id}: ${violation.help}`),
  ).toEqual([]);
};

// ---------------------------------------------------------------------------
// The three palette states
// ---------------------------------------------------------------------------

test('open cards are unchanged; the Data card carries the quiet uplift reveal', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/uplift-palette/edit');
  await page.getByRole('button', { name: 'Add step' }).click();
  const lib = page.locator('.library');

  // Open: local is the default and defaults are not labelled.
  await lib.getByLabel('Find a step').fill('code');
  const codeCard = lib.getByRole('button', { name: 'Code' }).first();
  await expect(codeCard).toBeVisible();
  await expect(codeCard.locator('.up-glyph')).toHaveCount(0);

  // Lite-with-uplift: the cloud glyph at rest, the reveal on focus-within,
  // the pitch from the offers manifest, the link into /account#cap.data.
  await lib.getByLabel('Find a step').fill('data');
  const uplift = lib.locator('.lib-uplift').first();
  await expect(uplift.locator('.up-glyph')).toBeVisible();
  await uplift.locator('.lib-item').focus();
  const strip = uplift.locator('.up-strip');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('Works here with smaller data.');
  await expect(strip).toContainText('Full version in the cloud handles millions of rows.');
  const link = strip.getByRole('link', { name: /See what full adds/ });
  await expect(link).toHaveAttribute('href', '/account#cap.data');

  // Clicking the card always adds the LOCAL step; the reveal never intercepts.
  await uplift.locator('.lib-item').click();
  await expect(page.locator('.metis-node')).toHaveCount(1);
  // No chip: the workflow's cloud toggle is off and the step is local.
  await expect(page.locator('.cloud-chip')).toHaveCount(0);
});

test('locked cards are offers-overlaid links with the Cloud only pill', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/uplift-locked/edit');
  await page.getByRole('button', { name: 'Add step' }).click();
  const lib = page.locator('.library');
  const locked = lib.locator('a.locked-card');
  await expect(locked).toHaveCount(4);
  await expect(locked.first()).toContainText('Memory');
  await expect(locked.first().locator('.cloud-pill')).toHaveText('Cloud only');
  await expect(locked.first()).toContainText('Available in Helix');
  await expect(locked.first()).toHaveAttribute('href', '/account');
  // No padlock text remains anywhere in the group.
  await expect(lib.locator('.locked-card .padlock')).toHaveCount(0);
});

for (const theme of THEMES) {
  test(`palette fidelity: uplift row focused, ${theme}`, async ({ page }) => {
    await login(page);
    await setTheme(page, theme);
    await page.goto('http://127.0.0.1:4180/workflows/uplift-shot/edit');
    await page.getByRole('button', { name: 'Add step' }).click();
    const lib = page.locator('.library');
    await lib.getByLabel('Find a step').fill('data');
    await lib.locator('.lib-uplift .lib-item').first().focus();
    await expect(lib.locator('.up-strip')).toBeVisible();
    await settle(page);
    if (mac) await expect(lib).toHaveScreenshot(`palette-uplift-${theme}.png`);
  });
}

test('palette fidelity at 390px: the reveal is always open on the narrow layout', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await login(page);
  await setTheme(page, 'dark');
  await page.goto('http://127.0.0.1:4180/workflows/uplift-mobile/edit');
  await page.getByRole('button', { name: 'Add step' }).click();
  const lib = page.locator('.library');
  await lib.getByLabel('Find a step').fill('data');
  await lib.locator('.lib-uplift .lib-item').first().focus();
  await expect(lib.locator('.up-strip')).toBeVisible();
  await settle(page);
  if (mac) await expect(lib).toHaveScreenshot('palette-uplift-390.png');
  await context.close();
});

// ---------------------------------------------------------------------------
// Where it runs: the workflow toggle + the per-step seg
// ---------------------------------------------------------------------------

test('the Policy seg is locked until the workflow allows cloud; Automatic demands a size', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/uplift-policy/edit');
  await addStep(page, /^Data$/);
  await page.locator('.metis-node').first().click();
  await page.getByRole('tab', { name: 'Policy' }).click();

  // Workflow toggle off: disabled seg + the lock note.
  const whereRuns = page.locator('.where-runs');
  await expect(whereRuns.locator('.insp-disabled')).toBeVisible();
  await expect(whereRuns.locator('.lock-note')).toHaveText('Turn on cloud for this workflow first.');

  await enableWorkflowCloud(page);
  await expect(whereRuns.locator('.insp-disabled')).toHaveCount(0);

  // Automatic reveals the required threshold; empty on blur = the error and
  // nothing saved (the seg would not survive a reload without a size).
  await whereRuns.getByRole('radio', { name: 'Automatic' }).click();
  const threshold = whereRuns.locator('.threshold');
  await expect(threshold).toBeVisible();
  await threshold.getByLabel('Size').focus();
  await threshold.getByLabel('Size').blur();
  await expect(threshold.locator('.err')).toHaveText('Set a size first');

  // Filled: saved onto the node and it survives save + reload.
  await threshold.getByLabel('Size').fill('50');
  await threshold.getByLabel('Size').blur();
  await expect(threshold.locator('.err')).toHaveCount(0);
  await page.locator('.inspector .ins-foot .btn-primary').click();
  await expect(page.locator('.builder-bar .saved-hint')).toBeVisible();
  await page.reload();
  await page.locator('.metis-node').first().click();
  await page.getByRole('tab', { name: 'Policy' }).click();
  await expect(whereRuns.getByRole('radio', { name: 'Automatic' })).toHaveAttribute('aria-checked', 'true');
  await expect(threshold.getByLabel('Size')).toHaveValue('50');
  // Automatic draws the outlined chip with the A on the canvas.
  await expect(page.locator('.cloud-chip.auto')).toBeVisible();
});

for (const theme of THEMES) {
  test(`policy fidelity: Automatic filled, ${theme}`, async ({ page }) => {
    await login(page);
    await setTheme(page, theme);
    await page.goto(`http://127.0.0.1:4180/workflows/uplift-policy-shot-${theme}/edit`);
    await addStep(page, /^Data$/);
    await page.locator('.metis-node').first().click();
    await enableWorkflowCloud(page);
    await page.getByRole('tab', { name: 'Policy' }).click();
    const whereRuns = page.locator('.where-runs');
    await whereRuns.getByRole('radio', { name: 'Automatic' }).click();
    await whereRuns.getByLabel('Size').fill('50');
    await whereRuns.getByLabel('Size').blur();
    await settle(page);
    if (mac) await expect(page.locator('.inspector')).toHaveScreenshot(`policy-automatic-${theme}.png`);
  });
}

test('the cloud chip shows for a cloud-routed step and hides when zoomed out', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/uplift-chip/edit');
  await addStep(page, /^Data$/);
  await page.locator('.metis-node').first().click();
  await enableWorkflowCloud(page);
  await page.getByRole('tab', { name: 'Policy' }).click();
  await page.locator('.where-runs').getByRole('radio', { name: 'In the cloud' }).click();
  const chip = page.locator('.cloud-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('aria-label', 'Runs in the cloud');

  // Below ~60% zoom the chip disappears; the workflow shape stays legible.
  const zoomOut = page.getByRole('button', { name: 'Zoom out' });
  for (let i = 0; i < 8; i += 1) {
    const zoomText = await page.locator('.zoom-val').innerText();
    if (Number.parseInt(zoomText, 10) < 60) break;
    await zoomOut.click();
  }
  await expect(chip).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// The consent gate
// ---------------------------------------------------------------------------

test('Escape keeps it on this computer: the run proceeds locally with the mirror receipt', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/uplift-consent-esc/edit');
  await addStep(page, /^Data$/);
  await enableWorkflowCloud(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();

  const modal = page.locator('.consent-modal');
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Send to the cloud' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  // The run still happens - on this computer - and the receipt says so.
  await expect(page.locator('.metis-node.is-completed')).toHaveCount(1);

  const runsUrl = page.url().replace(/\/edit.*$/, '/runs');
  await page.goto(runsUrl);
  await page.locator('.run-row').first().click();
  const receipt = page.locator('.audit-row');
  await expect(receipt).toContainText('You kept this workflow on this computer');
  await expect(receipt).toHaveClass(/kept/);
});

test('"Send to the cloud" with "don\'t ask again" stamps the workflow consent', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/uplift-consent-yes/edit');
  await addStep(page, /^Data$/);
  await enableWorkflowCloud(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();

  const modal = page.locator('.consent-modal');
  await expect(modal).toBeVisible();
  await modal.locator('.consent-remember').click();
  await modal.getByRole('button', { name: 'Send to the cloud' }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator('.metis-node.is-completed')).toHaveCount(1);

  // Remembered: the workflow modal shows the receipt line + reset.
  await page.getByRole('button', { name: 'Cloud for this workflow' }).click();
  const cloudModal = page.getByRole('dialog', { name: 'Cloud for this workflow' });
  await expect(cloudModal.locator('.reset-line')).toContainText(/You said .don.t ask again. on/);
  await cloudModal.getByRole('button', { name: 'Close' }).click();

  // The receipt: allowed, for all future runs; a second Run never asks again.
  const runsUrl = page.url().replace(/\/edit.*$/, '/runs');
  await page.goto(runsUrl);
  await page.locator('.run-row').first().click();
  const receipt = page.locator('.audit-row');
  await expect(receipt).toContainText('You allowed cloud processing for this workflow');
  await expect(receipt).toContainText('for all future runs');
  await page.goBack();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.consent-modal')).toHaveCount(0);
  await expect(page.locator('.metis-node.is-completed')).toHaveCount(1);
});

test('a plain yes consents for this run only: the next Run asks again', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/uplift-consent-once/edit');
  await addStep(page, /^Data$/);
  await enableWorkflowCloud(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const modal = page.locator('.consent-modal');
  await modal.getByRole('button', { name: 'Send to the cloud' }).click();
  await expect(page.locator('.metis-node.is-completed')).toHaveCount(1);

  const runsUrl = page.url().replace(/\/edit.*$/, '/runs');
  await page.goto(runsUrl);
  await page.locator('.run-row').first().click();
  const receipt = page.locator('.audit-row');
  await expect(receipt).toContainText('You allowed cloud processing for this workflow');
  await expect(receipt).not.toContainText('for all future runs');

  await page.goBack();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.consent-modal')).toBeVisible();
  await page.keyboard.press('Escape');
});

for (const theme of THEMES) {
  test(`consent modal fidelity + axe, ${theme}`, async ({ page }) => {
    await login(page);
    await setTheme(page, theme);
    await page.goto(`http://127.0.0.1:4180/workflows/uplift-consent-shot-${theme}/edit`);
    await addStep(page, /^Data$/);
    await enableWorkflowCloud(page);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('.consent-modal')).toBeVisible();
    await settle(page);
    if (mac) await expect(page.locator('.consent-modal')).toHaveScreenshot(`consent-${theme}.png`);
    await noBlockingViolations(page, '.consent-modal');
  });
}

// ---------------------------------------------------------------------------
// Degraded runs: banner, badge, chip, row icon, receipt
// ---------------------------------------------------------------------------

test('a degraded run stays green: banner + "Ran here instead" on the canvas', async ({ page }) => {
  await login(page);
  await page.goto(
    'http://127.0.0.1:4180/workflows/wf-degraded-demo/edit?run=exec_seeded_degraded',
  );
  const banner = page.locator('.degraded-banner');
  await expect(banner).toContainText("The cloud wasn't reachable");
  await expect(banner).toContainText('The run still completed.');

  const dataNode = page.locator('.metis-node', { hasText: 'Ran here instead' });
  await expect(dataNode.locator('.fnode-badge.b-degraded')).toBeVisible();
  await expect(dataNode.locator('.cloud-chip.degraded')).toBeVisible();
  // The run state itself stays completed-green; amber is only the modifier.
  await expect(dataNode).toHaveClass(/is-completed/);

  await banner.getByRole('button', { name: 'See which step' }).click();
  await expect(page.locator('.inspector')).toBeVisible();
});

test('the run detail page carries the degraded banner and the audit receipt', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/executions/exec_seeded_degraded');
  await expect(page.locator('.degraded-banner.static')).toContainText("The cloud wasn't reachable");
  const receipt = page.locator('.audit-row');
  await expect(receipt).toContainText('You allowed cloud processing for this workflow');
  await expect(receipt).toContainText('for all future runs');
  await expect(page.locator('.step-tag')).toHaveText('Ran here instead');
});

test('the run list marks a degraded run with the quiet cloud-off icon', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/workflows/wf-degraded-demo/runs');
  const degradedRow = page.locator('.run-row', { hasText: 'exec_seeded_degraded' });
  await expect(degradedRow.locator('.mini-degraded')).toBeVisible();
  await expect(degradedRow.locator('.run-status')).toHaveText('COMPLETED');
  const cleanRow = page.locator('.run-row', { hasText: 'exec_seeded_keptlocal' });
  await expect(cleanRow.locator('.mini-degraded')).toHaveCount(0);
});

for (const theme of THEMES) {
  test(`degraded banner + audit row fidelity, ${theme}`, async ({ page }) => {
    await login(page);
    await setTheme(page, theme);
    await page.goto(
      'http://127.0.0.1:4180/workflows/wf-degraded-demo/edit?run=exec_seeded_degraded',
    );
    const banner = page.locator('.degraded-banner');
    await expect(banner).toBeVisible();
    await settle(page);
    if (mac) await expect(banner).toHaveScreenshot(`degraded-banner-${theme}.png`);

    await page.goto('http://127.0.0.1:4180/executions/exec_seeded_degraded');
    const receipt = page.locator('.audit-row');
    await expect(receipt).toBeVisible();
    await settle(page);
    if (mac) {
      await expect(receipt).toHaveScreenshot(`audit-row-${theme}.png`, {
        mask: [receipt.locator('.when')],
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Account & Cloud: page states, axe, connect round-trip, offline fallback
// ---------------------------------------------------------------------------

test('the account page: disconnected hero + the capability grid from offers', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/account');
  await expect(page.locator('.acct-hero h2')).toHaveText('Do more with Helix Cloud');
  await expect(page.getByRole('button', { name: 'Connect your Helix account' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New here? Create an account' })).toBeVisible();

  const cards = page.locator('.capcard');
  await expect(cards).toHaveCount(5);
  const bigData = page.locator('.capcard', { hasText: 'Big data' });
  await expect(bigData.locator('.chip')).toHaveText('Available');
  await expect(bigData).toContainText('Millions of rows, not thousands');
  await expect(page.locator('.chip', { hasText: 'Coming soon' })).toHaveCount(4);
  await noBlockingViolations(page);
});

for (const theme of THEMES) {
  test(`account disconnected fidelity, ${theme}`, async ({ page }) => {
    await login(page);
    await setTheme(page, theme);
    await page.goto('http://127.0.0.1:4180/account');
    await expect(page.locator('.capcard')).toHaveCount(5);
    await settle(page);
    if (mac) await expect(page).toHaveScreenshot(`account-disconnected-${theme}.png`);
  });
}

test('account fidelity at 390px', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await login(page);
  await setTheme(page, 'dark');
  await page.goto('http://127.0.0.1:4180/account');
  await expect(page.locator('.capcard')).toHaveCount(5);
  await settle(page);
  if (mac) await expect(page).toHaveScreenshot('account-390.png', { fullPage: true });
  await context.close();
});

test('connect round-trip: Helix sign-in, back connected, entitled palette, disconnect', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:4180/account');
  await page.getByRole('button', { name: 'Connect your Helix account' }).click();

  // The stub OIDC auto-approves and the callback redirects back here.
  await expect(page).toHaveURL(/\/account/);
  await expect(page.locator('.plan-pill')).toContainText('Helix Cloud');
  await expect(page.locator('.acct-email')).toHaveText('user@helix.example');
  const bigData = page.locator('.capcard', { hasText: 'Big data' });
  await expect(bigData.locator('.chip')).toHaveText('Included');

  // Connected + entitled: the palette's middle state flips to the receipt.
  if (mac) {
    await settle(page);
    await expect(page).toHaveScreenshot('account-connected-dark.png', {
      mask: [page.locator('.acct-email')],
    });
  }
  await page.goto('http://127.0.0.1:4180/workflows/uplift-entitled/edit');
  await page.getByRole('button', { name: 'Add step' }).click();
  const lib = page.locator('.library');
  await lib.getByLabel('Find a step').fill('data');
  await lib.locator('.lib-uplift .lib-item').first().focus();
  await expect(lib.locator('.up-strip')).toContainText('Cloud: connected');

  // Disconnect returns the hero to its disconnected state.
  await page.goto('http://127.0.0.1:4180/account');
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.locator('.acct-hero h2')).toHaveText('Do more with Helix Cloud');
});

test('stub down: the static manifest still renders and the hero reads offline', async ({ page, request }) => {
  await request.post('http://127.0.0.1:4181/e2e/helix-stub', { data: { up: false } });
  try {
    await login(page);
    await page.goto('http://127.0.0.1:4180/account');
    await expect(page.locator('.offline-note')).toContainText("You're offline.");
    // The bundled manifest keeps the grid rendering - everything coming soon.
    await expect(page.locator('.capcard')).toHaveCount(5);
    await expect(page.locator('.chip', { hasText: 'Coming soon' })).toHaveCount(5);

    // The palette still shows the uplift affordance and the locked links.
    await page.goto('http://127.0.0.1:4180/workflows/uplift-offline/edit');
    await page.getByRole('button', { name: 'Add step' }).click();
    const lib = page.locator('.library');
    await expect(lib.locator('a.locked-card')).toHaveCount(4);
    await lib.getByLabel('Find a step').fill('data');
    await expect(lib.locator('.lib-uplift .up-glyph')).toBeVisible();
  } finally {
    await request.post('http://127.0.0.1:4181/e2e/helix-stub', { data: { up: true } });
  }
});
