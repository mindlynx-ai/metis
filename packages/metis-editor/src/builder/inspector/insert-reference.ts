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
 * Insert a `{{node-...}}` reference at the cursor of the focused config field.
 * The Setup form's text lives in four different state owners (draft map, header
 * rows, body draft, operation rows), so rather than thread a setter through
 * each, we write the DOM element directly and dispatch a native `input` event -
 * React's existing onChange fires and routes through every unchanged commit
 * path. ponytail: one helper, zero changes to the field components.
 */

/** Splice `text` into `value` between start and end, returning value + caret. */
export function computeInsertion(
  value: string,
  start: number,
  end: number,
  text: string,
): { value: string; caret: number } {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  return { value: value.slice(0, from) + text + value.slice(to), caret: from + text.length };
}

/** Reference-meaningful text controls: where a `{{...}}` token makes sense. */
export function isReferenceTarget(
  el: Element | null,
): el is HTMLInputElement | HTMLTextAreaElement {
  const isTextInput =
    el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'url');
  if (!isTextInput && !(el instanceof HTMLTextAreaElement)) return false;
  const field = el as HTMLInputElement | HTMLTextAreaElement;
  // Monaco's hidden IME textarea. It passes the instanceof check above and is
  // NOT the editor's value - the model is - so writing to it would look like a
  // successful insert and do nothing. The editor registers a real handle
  // instead (registerInsertHandle), which insertReference prefers; this is the
  // belt to that braces, so the DOM path can never claim it even if the
  // ordering ever changes.
  if (field.classList.contains('ime-text-area')) return false;
  // Key inputs and the non-config text areas take names/notes, not references.
  // The logic node's field is a ctx.input path, not a {{node}} reference.
  if (field.classList.contains('kv-key') || field.classList.contains('logic-field')) return false;
  if (field.id === 'sample-req-input' || field.id === 'details-notes' || field.id === 'details-tags') {
    return false;
  }
  return true;
}

/** Programmatic value set that React's controlled inputs still see (via input event). */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

export function insertAtCursor(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const { value, caret } = computeInsertion(el.value, start, end, text);
  setNativeValue(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  el.setSelectionRange(caret, caret);
}

/**
 * The route into an editor that is not a text control.
 *
 * `insertAtCursor` below works by writing through a native `value` setter and
 * firing a synthetic `input` event. That is exactly right for an `<input>` or a
 * `<textarea>` and reaches nothing at all in Monaco, whose value lives in a
 * model. Worse than nothing: its hidden `.ime-text-area` IS a textarea, so the
 * write would look like it worked. Without this every `{{...}}` chip on a code,
 * SQL or JSON field would land nowhere while reporting success.
 *
 * It also fixes the modal, which is the other reason it is a module-level
 * registry rather than a ref on the panel: `insertReference` requires the
 * remembered element to sit inside `.setup-panel`, and a portalled modal does
 * not. A registered handle does not care where the editor is rendered.
 */
type InsertHandle = (text: string) => void;

let handle: InsertHandle | undefined;

/**
 * Claim the insert route on focus, release it on blur.
 *
 * @param next - the handle to register, or `undefined` to release.
 * @param owner - when releasing, the handle doing the releasing. A blur can
 *   arrive AFTER the next editor's focus, and clearing blindly would leave
 *   nothing registered while an editor is plainly focused - the chip would then
 *   go to the clipboard with the cursor sitting right there.
 */
export function registerInsertHandle(next?: InsertHandle, owner?: InsertHandle): void {
  if (next) {
    handle = next;
    return;
  }
  if (!owner || handle === owner) handle = undefined;
}

/** The focused editor's insert function, if one holds focus. */
export function activeInsertHandle(): InsertHandle | undefined {
  return handle;
}
