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
 * Unlinking two steps.
 *
 * Drawing a link always worked and undoing it never did: the canvas passed no
 * `onEdgesChange`, so XYFlow dropped every edge change including selection -
 * which meant even the undiscoverable Backspace route found nothing selected to
 * delete. The only way out was deleting a step and rebuilding it.
 *
 * Driven with the real mouse at real coordinates rather than `locator.click()`,
 * because Playwright treats an SVG `<g>` and a transparent stroke as invisible
 * and refuses to act on them. A synthetic DOM click passed against a control
 * that a person could not actually see or reach, so this asserts the visible
 * state too.
 */
import { test, expect, type Page } from '@playwright/test';
import { login, addStep } from './helpers.js';

/** The midpoint of the first link, in viewport coordinates. */
const linkMidpoint = (page: Page) =>
  page.evaluate(() => {
    const path = document.querySelector('.edge-hit') as SVGPathElement | null;
    if (!path) return undefined;
    const mid = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM();
    if (!m) return undefined;
    return { x: mid.x * m.a + mid.y * m.c + m.e, y: mid.x * m.b + mid.y * m.d + m.f };
  });

/**
 * Drag from the first step's output handle to the second step's input.
 *
 * The hover-then-press and the retry are both load-bearing and copied from
 * branch-wiring.spec.ts: XYFlow starts a connection from a pointer sequence, and
 * a single synthetic drag lands often enough to look right and rarely enough to
 * flake.
 */
const drawLink = async (page: Page) => {
  const source = page.locator('.react-flow__handle-right').first();
  const target = page.locator('.react-flow__handle-left').last();
  const drag = async () => {
    const from = await source.boundingBox();
    const to = await target.boundingBox();
    if (!from || !to) return;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await source.hover();
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2);
    await page.mouse.up();
  };
  await expect(async () => {
    if ((await page.locator('.react-flow__edge').count()) === 0) await drag();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  }).toPass({ timeout: 15_000 });
};

/** Remove the first link using the control on it, as a person would. */
const removeLink = async (page: Page) => {
  const point = await linkMidpoint(page);
  expect(point, 'the link should have measurable geometry').toBeTruthy();
  await page.mouse.move(point!.x, point!.y);
  const box = await page.locator('.edge-drop').first().boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.up();
};

const buildTwoLinkedSteps = async (page: Page) => {
  await page.goto('http://127.0.0.1:4180/workflows/new');
  await addStep(page, /Webhook/);
  await addStep(page, /Code/);
  // Steps are not linked for you; the link is the thing under test, so draw it.
  await expect(page.locator('.metis-node')).toHaveCount(2);
  await drawLink(page);
};

test('a link can be removed without deleting either step', async ({ page }) => {
  await login(page);
  await buildTwoLinkedSteps(page);

  const control = page.locator('.edge-drop').first();
  // Hidden until wanted: a cross on every link would be noise.
  await expect(control).toHaveCSS('opacity', '0');

  const point = await linkMidpoint(page);
  expect(point, 'the link should have measurable geometry').toBeTruthy();
  await page.mouse.move(point!.x, point!.y);
  // Revealed by hovering the LINE, not the control - that is the discovery
  // path, and it is driven from React state because React Flow's edge group
  // does not reliably receive CSS :hover.
  await expect(control).toHaveCSS('opacity', '1');

  const box = await control.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.up();

  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  // The point of the whole fix: the steps survive.
  await expect(page.locator('.metis-node')).toHaveCount(2);
});

test('the two steps can be linked again afterwards', async ({ page }) => {
  await login(page);
  await buildTwoLinkedSteps(page);

  await removeLink(page);
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);

  // A stale edge left in the store would make connect() refuse this as a
  // duplicate, so relinking proves the removal was real and not just visual.
  await drawLink(page);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
});
