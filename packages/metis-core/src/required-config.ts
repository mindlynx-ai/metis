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
 * Required config, checked before a workflow goes live.
 *
 * The catalogue has always declared which fields a step cannot work without,
 * and nothing enforced it. `validateDefinition` checks the SHAPE of a graph -
 * start nodes, cycles, loops - and never looks inside a node. So a code step
 * with no code saved without a murmur and published cheerfully: "your workflow
 * is live", for a workflow that could not possibly run. The only sign was a
 * failed run afterwards, by which point the trigger had already fired.
 *
 * This closes it at publish rather than in the editor, because publish is the
 * moment a workflow becomes something that runs on its own, and because the
 * editor is not the only way in - the API publishes too.
 *
 * Deliberately narrow: presence only. It does not type-check values, and it
 * does not try to parse anybody's code. An empty box is a mistake you can be
 * certain about; almost nothing else is.
 */
import { getCatalogue, getEntry } from '@mindlynx/metis-catalogue';

/** Node shapes on the wire: Helix nests config under data, the engine keeps it flat. */
interface DefinitionNode {
  id?: string;
  type?: string;
  config?: Record<string, unknown>;
  data?: { label?: string; config?: Record<string, unknown> };
}

/**
 * Deprecated spellings that still satisfy a required field.
 *
 * A workflow authored on the old name runs today, so refusing to publish it
 * would be a regression wearing a fix's clothes.
 */
const ALIASES: Record<string, readonly string[]> = {
  code: ['script'],
  inputData: ['input'],
  timeout: ['timeoutMs'],
};

/** Absent, or nothing but whitespace. `0` and `false` are answers. */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim() === '';
}

/** What to call this step in a message a person has to act on. */
function nameOf(node: DefinitionNode): string {
  const label = node.data?.label;
  if (typeof label === 'string' && label.trim() !== '') return label.trim();
  return node.type ?? 'a step';
}

/** The message for one empty field on one step. */
function emptyFieldError(node: DefinitionNode, field: string, title: string): string {
  const name = nameOf(node);
  // A step that has not been renamed is labelled after its type, so a code step
  // needing its Code field read 'Code: "Code" is needed'. The same word twice
  // reads like a bug in the message rather than a message about a bug.
  return name.toLowerCase() === title.toLowerCase()
    ? `This ${title} step needs its ${title.toLowerCase()} filled in before it can be published`
    : `${name}: "${title}" is needed before this can be published`;
}

/** Every required field left empty on ONE step. */
function stepErrors(node: DefinitionNode): string[] {
  const entry = node.type ? getEntry(getCatalogue(), node.type) : undefined;
  // Unknown is not invalid: a pack node, or a type from a newer Metis. This
  // check refuses to be the reason a valid workflow cannot be published.
  if (!entry) return [];
  const schema = entry.configSchema as
    | { required?: string[]; properties?: Record<string, { title?: string; default?: unknown }> }
    | undefined;
  const config = node.data?.config ?? node.config ?? {};
  const errors: string[] = [];
  for (const field of schema?.required ?? []) {
    const property = schema?.properties?.[field];
    // A field with a DEFAULT can never actually be missing - the handler falls
    // back to it. `required` does double duty in this product: it is also what
    // the inspector shows up front rather than behind "Show advanced", so the
    // code step's `language` is on the list purely to be visible. Refusing to
    // publish over a field that already has an answer would be nonsense.
    if (property?.default !== undefined) continue;
    const names = [field, ...(ALIASES[field] ?? [])];
    if (names.some((name) => !isEmpty(config[name]))) continue;
    errors.push(emptyFieldError(node, field, property?.title ?? field));
  }
  return errors;
}

/**
 * Every required field left empty, one plain sentence each.
 *
 * @param definition - the workflow being published.
 * @returns errors, empty when nothing is missing.
 */
export function missingRequiredConfig(definition: { nodes?: readonly DefinitionNode[] }): string[] {
  return (definition.nodes ?? []).flatMap(stepErrors);
}
