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
 * The catalogue has always said which fields a step cannot work without - the
 * code step lists `code` - and nothing enforced it. A step could be left empty,
 * saved without a murmur, and PUBLISHED: "your workflow is live" for a workflow
 * that could not possibly run. The only sign was a failed run afterwards.
 *
 * Graph shape was validated all along (start nodes, cycles, loops). Node config
 * never was.
 */
import { describe, it, expect } from 'vitest';
import { missingRequiredConfig } from '../required-config.js';

const node = (type: string, config: Record<string, unknown>, label?: string) => ({
  id: `node-${type}`,
  type,
  data: { label, config },
});

describe('missingRequiredConfig', () => {
  it('names the step and the field when a required one is empty', () => {
    const errors = missingRequiredConfig({ nodes: [node('code', { code: '' }, 'Tidy the rows')] });
    expect(errors).toHaveLength(1);
    // The step's own name, because "node-3f2a" means nothing on a canvas.
    expect(errors[0]).toContain('Tidy the rows');
    expect(errors[0]).toContain('Code');
  });

  it('does not say the same word twice when the step is named after its field', () => {
    // An unrenamed code step is labelled "Code" and its empty field is "Code",
    // which gave 'Code: "Code" is needed' - that reads like a broken message
    // rather than a message about something broken.
    const errors = missingRequiredConfig({ nodes: [node('code', {}, 'Code')] });
    expect(errors[0]).toBe(
      'This Code step needs its code filled in before it can be published',
    );
  });

  it('falls back to the step type when it has no label', () => {
    const errors = missingRequiredConfig({ nodes: [node('code', {})] });
    expect(errors[0]).toContain('code');
  });

  it('treats whitespace as empty, because it is', () => {
    expect(missingRequiredConfig({ nodes: [node('code', { code: '   \n' })] })).toHaveLength(1);
  });

  it('passes a step that is filled in', () => {
    expect(missingRequiredConfig({ nodes: [node('code', { code: 'return 1;' })] })).toEqual([]);
  });

  it('accepts a legacy alias rather than failing a workflow that already runs', () => {
    // `script` is the deprecated spelling of `code`. A workflow using it works,
    // so refusing to publish it would be a regression dressed as a fix.
    expect(missingRequiredConfig({ nodes: [node('code', { script: 'return 1;' })] })).toEqual([]);
  });

  it('says nothing about a step type the catalogue does not know', () => {
    // A pack node, or a type from a newer Metis. Unknown is not invalid.
    expect(missingRequiredConfig({ nodes: [node('made-up-type', {})] })).toEqual([]);
  });

  it('accepts a field that is present but falsy', () => {
    // 0 and false are answers. Only absent and blank are missing.
    const errors = missingRequiredConfig({ nodes: [node('code', { code: 0 })] });
    expect(errors).toEqual([]);
  });

  it('reports every empty step, not just the first', () => {
    const errors = missingRequiredConfig({
      nodes: [node('code', {}, 'One'), node('code', {}, 'Two')],
    });
    expect(errors).toHaveLength(2);
  });

  it('never asks for a field that already has a default', () => {
    // The code step's `language` is on the catalogue's `required` list purely so
    // the inspector shows it up front rather than behind "Show advanced" - it
    // defaults to typescript, so it is never actually absent. Blocking publish
    // over a field with an answer would be nonsense, and this pins that.
    const errors = missingRequiredConfig({ nodes: [node('code', { code: 'return 1;' })] });
    expect(errors).toEqual([]);
    const stillCaught = missingRequiredConfig({ nodes: [node('code', {}, 'Empty')] });
    // ...but the field with no default is still caught, and only that one.
    expect(stillCaught).toHaveLength(1);
    expect(stillCaught[0]).toContain('Code');
    expect(stillCaught[0]).not.toContain('Language');
  });

  it('reads config from either shape, because both are on the wire', () => {
    // Helix nests it under data.config; the engine keeps it flat internally.
    const flat = { id: 'n1', type: 'code', config: { code: 'return 1;' } };
    expect(missingRequiredConfig({ nodes: [flat] })).toEqual([]);
  });
});
