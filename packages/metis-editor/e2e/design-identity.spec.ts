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
 * The standing design gate, first cut: every identity
 * mockup renders in both themes, carries the load-bearing structure,
 * honours reduced motion, and is captured light and dark. Screenshot
 * baselines are recorded on macOS (the design workstation); other
 * platforms still run every structural assertion.
 */
import { test, expect, type Page } from '@playwright/test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const mockups = join(dirname(fileURLToPath(import.meta.url)), '..', 'design', 'mockups');
const pageUrl = (name: string, theme: 'light' | 'dark') => {
  const fileHref = pathToFileURL(join(mockups, `${name}.html`)).href;
  return `${fileHref}?theme=${theme}`;
};

const PAGES = ['canvas', 'inspector', 'palette', 'runs'] as const;
const THEMES = ['light', 'dark'] as const;

const settle = async (page: Page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
};

for (const theme of THEMES) {
  for (const name of PAGES) {
    test(`${name} mockup renders the identity in ${theme}`, async ({ page }) => {
      await page.goto(pageUrl(name, theme));
      await settle(page);

      await expect(page.locator('.wordmark')).toBeVisible();
      await expect(page.locator('.btn-run')).toBeVisible();
      if (name === 'canvas' || name === 'inspector') {
        await expect(page.locator('.node')).toHaveCount(4);
        await expect(page.locator('.edge')).toHaveCount(3);
      }
      if (name === 'inspector') {
        await expect(page.locator('.inspector h2')).toHaveText('Big order?');
      }
      if (name === 'palette') {
        await expect(page.locator('.palette-item')).toHaveCount(8);
        await expect(page.locator('.locked-card')).toHaveCount(3);
        await expect(page.locator('.locked-card .upgrade').first()).toContainText('Helix');
      }
      if (name === 'runs') {
        await expect(page.locator('.run-row')).toHaveCount(3);
        await expect(page.locator('.temporal-link')).toBeVisible();
      }

      // Screenshot baselines are recorded on macOS (the design
      // workstation); structural assertions above run everywhere.
      if (process.platform === 'darwin') {
        await expect(page).toHaveScreenshot(`${name}-${theme}.png`, { fullPage: false });
      }
    });
  }
}

test('reduced motion zeroes every transition and animation', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(pageUrl('canvas', 'light'));
  await settle(page);
  const durations = await page.evaluate(() => {
    const probe = document.querySelector('.node');
    const styles = probe ? getComputedStyle(probe) : undefined;
    return {
      transition: styles?.transitionDuration ?? '',
      animated: [...document.querySelectorAll('.edge.active')].map(
        (edge) => getComputedStyle(edge).animationDuration,
      ),
    };
  });
  expect(durations.transition.split(',').every((value) => Number.parseFloat(value) < 0.02)).toBe(
    true,
  );
  expect(durations.animated.every((value) => Number.parseFloat(value) < 0.02)).toBe(true);
  await context.close();
});

test('keyboard focus is visible on interactive elements', async ({ page }) => {
  await page.goto(pageUrl('canvas', 'light'));
  await settle(page);
  await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => {
    const active = document.activeElement;
    return active ? getComputedStyle(active).outlineWidth : '';
  });
  expect(Number.parseFloat(outline)).toBeGreaterThan(0);
});
