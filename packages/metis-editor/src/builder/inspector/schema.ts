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
 * Pure schema helpers shared by the palette (default seeding) and the
 * inspector (field widgets). No React, no state: a config schema in, a
 * widget kind / default / draft string out. The widget registry (Phase 2)
 * builds on top of these.
 */
import type { JsonSchema, JsonSchemaProperty } from '../../api.js';

/** Fields whose string content is code, so they get a mono textarea. */
const CODE_FIELDS = new Set(['code', 'script', 'query', 'text', 'html', 'template']);

export type Widget =
  | 'select'
  | 'checkbox'
  | 'number'
  | 'textarea'
  | 'json'
  | 'method'
  | 'headers'
  | 'body'
  | 'connector'
  | 'operationParams'
  | 'dataBuilder'
  | 'switchBuilder'
  | 'logicBuilder'
  | 'filterBuilder'
  | 'uri'
  | 'date'
  | 'text';

/** True when a property is the `{ type: enum, content }` request-body envelope. */
function isBodyEnvelope(property: JsonSchemaProperty): boolean {
  const props = property.properties;
  return Boolean(props && props.type?.enum && 'content' in props);
}

/** x-helix-widget hints that map straight to a widget (no extra conditions). */
const HINT_WIDGETS: Record<string, Widget> = {
  connectorRef: 'connector',
  operationParams: 'operationParams',
  dataBuilder: 'dataBuilder',
  switchBuilder: 'switchBuilder',
  logicBuilder: 'logicBuilder',
  filterBuilder: 'filterBuilder',
};

/**
 * Pick the widget for a field. Explicit Helix hints (`x-helix-widget`,
 * `format`) win; then structural shape (headers, body envelope); then
 * enum/type; then the code-field name convention.
 */
export function widgetFor(name: string, property: JsonSchemaProperty): Widget {
  const hint = property['x-helix-widget'];
  if (hint && HINT_WIDGETS[hint]) return HINT_WIDGETS[hint];
  if (hint === 'method' || (name === 'method' && property.enum)) return 'method';
  if (hint === 'headers' || name === 'headers') return 'headers';
  if (name === 'body' && isBodyEnvelope(property)) return 'body';
  if (property.format === 'uri' || property.format === 'url') return 'uri';
  if (property.format === 'date' || property.format === 'date-time') return 'date';
  if (property.enum && property.enum.length > 0) return 'select';
  if (property.type === 'boolean') return 'checkbox';
  if (property.type === 'number' || property.type === 'integer') return 'number';
  if (property.type === 'object' || property.type === 'array') return 'json';
  if (CODE_FIELDS.has(name)) return 'textarea';
  return 'text';
}

/** Rich widgets own their value as a structured object, not a draft string. */
export const RICH_WIDGETS: ReadonlySet<Widget> = new Set([
  'method',
  'headers',
  'body',
  'operationParams',
  'dataBuilder',
  'switchBuilder',
  'logicBuilder',
  'filterBuilder',
]);

/** Every property's `default`, keyed by name (skips those without one). */
export function defaultsFor(schema: JsonSchema | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    if (property.default !== undefined) out[name] = property.default;
  }
  return out;
}

/** A stored config value as the string a text/number/json control shows. */
export function toDraftValue(value: unknown, widget: Widget): string {
  if (value === undefined || value === null) return '';
  if (widget === 'json' || widget === 'headers') return JSON.stringify(value, null, 2);
  return String(value);
}

/** Parse a control's string back to a config value (or an error message). */
export function fromDraftValue(raw: string, widget: Widget): { value?: unknown; error?: string } {
  if (raw === '') return { value: undefined };
  if (widget === 'number') {
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? { error: 'must be a number' } : { value: parsed };
  }
  if (widget === 'checkbox') return { value: raw === 'true' };
  if (widget === 'json' || widget === 'headers') {
    try {
      return { value: JSON.parse(raw) };
    } catch {
      return { error: 'must be valid JSON' };
    }
  }
  return { value: raw };
}
