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
import { expect, type Page } from '@playwright/test';

/** Sign in to the dev harness (dev-core seeds jeremy/pw) and land on Home. */
export const login = async (page: Page) => {
  await page.goto('http://127.0.0.1:4180/login');
  await page.getByLabel('User').fill('jeremy');
  await page.getByLabel('Password').fill('pw');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
};

/**
 * Add a step in the builder: open the floating node library from "Add step",
 * then pick the matching entry (the library closes once the node is added).
 */
export const addStep = async (page: Page, label: RegExp) => {
  await page.getByRole('button', { name: 'Add step' }).click();
  const lib = page.locator('.library');
  // Type to surface the step as a flat ranked result - it may otherwise sit in
  // a collapsed app category. Strip regex anchors/specials for the query text.
  const term = label.source.replace(/[\\^$.*+?()[\]{}|]/g, ' ').trim();
  await lib.getByLabel('Find a step').fill(term);
  await lib.getByRole('button', { name: label }).first().click();
};
