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

/**
 * Drive a code editor field through Monaco's MODEL, never the keyboard.
 *
 * Typing is not a way to set a value here: Monaco auto-closes brackets and
 * quotes, so `page.keyboard.type('{"a":"b"}')` arrives as something else
 * entirely - three specs failed exactly that way when these helpers typed.
 * `monaco.editor.getEditors()` is the registry Monaco keeps of every editor on
 * the page (CodeEditor.tsx puts the api on the window); the right one is
 * whichever owns this field's DOM node. `setValue` fires the same change event
 * a keystroke does, so React still commits on it.
 */
const onEditor = (
  page: Page,
  field: string,
  action: 'get' | 'set' | 'cursor',
  arg = '',
): Promise<string> => {
  const selector = field.startsWith('.') || field.startsWith('#') ? field : `[data-field="${field}"]`;
  return page
    .locator(`${selector} .monaco-editor`)
    .first()
    .evaluate((element, payload) => {
      const win = window as unknown as {
        monaco?: {
          editor: {
            getEditors(): {
              getDomNode(): HTMLElement | null;
              getValue(): string;
              setValue(value: string): void;
              setPosition(at: { lineNumber: number; column: number }): void;
              getModel(): { getPositionAt(offset: number): { lineNumber: number; column: number } } | null;
              focus(): void;
            }[];
          };
        };
      };
      const editor = (win.monaco?.editor.getEditors() ?? []).find((candidate) => {
        const dom = candidate.getDomNode();
        return dom === element || dom?.contains(element) === true;
      });
      if (!editor) throw new Error('no Monaco editor owns that field');
      if (payload.action === 'set') editor.setValue(payload.arg);
      if (payload.action === 'cursor') {
        const model = editor.getModel();
        if (model) editor.setPosition(model.getPositionAt(Number(payload.arg)));
        editor.focus();
      }
      return editor.getValue();
    }, { action, arg });
};

/** Replace a code editor field's whole value. */
export const setEditorValue = async (page: Page, field: string, text: string): Promise<void> => {
  const selector = field.startsWith('.') || field.startsWith('#') ? field : `[data-field="${field}"]`;
  // Click first: the variable palette only offers an insert into a FOCUSED
  // editor, and specs that set a value then click a chip depend on that.
  await page.locator(`${selector} .monaco-editor`).first().click();
  await onEditor(page, field, 'set', text);
  // React commits on the change event; give it the tick before anything asserts.
  await page.waitForTimeout(120);
};

/** What a code editor field currently holds, read from the model. */
export const editorValue = (page: Page, field: string): Promise<string> =>
  onEditor(page, field, 'get');

/**
 * Put the caret at a character offset, for tests that then insert a reference.
 * The textarea equivalent was `setSelectionRange`, which Monaco has no answer
 * for from the outside - but its model converts an offset to a position.
 */
export const setEditorCursor = async (page: Page, field: string, offset: number): Promise<void> => {
  const selector = field.startsWith('.') || field.startsWith('#') ? field : `[data-field="${field}"]`;
  await page.locator(`${selector} .monaco-editor`).first().click();
  await onEditor(page, field, 'cursor', String(offset));
};
