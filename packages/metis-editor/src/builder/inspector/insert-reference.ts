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
