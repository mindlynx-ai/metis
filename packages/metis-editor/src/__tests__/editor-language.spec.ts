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
 * Which grammar a field gets. Pure, so it is unit-tested here; the editor it
 * feeds can only be proven in a browser (this suite ships no DOM).
 */
import { describe, it, expect } from 'vitest';
import { editorLanguageFor } from '../builder/inspector/editor-language.js';

describe('editorLanguageFor', () => {
  it('follows the code step own language field', () => {
    expect(editorLanguageFor('code', 'textarea', { language: 'python' })).toBe('python');
    expect(editorLanguageFor('code', 'textarea', { language: 'javascript' })).toBe('javascript');
  });

  it('defaults a code step to javascript, matching the catalogue', () => {
    expect(editorLanguageFor('code', 'textarea', {})).toBe('javascript');
  });

  it('falls back to javascript for a language Metis no longer runs', () => {
    // TypeScript is gone entirely. The step will be refused by name at run
    // time; colouring it as JavaScript is the least misleading thing the editor
    // can do in the meantime.
    expect(editorLanguageFor('code', 'textarea', { language: 'typescript' })).toBe('javascript');
  });

  it('treats the deprecated script alias like code', () => {
    expect(editorLanguageFor('script', 'textarea', { language: 'python' })).toBe('python');
  });

  it('gives every json widget the json grammar', () => {
    expect(editorLanguageFor('auth', 'json', {})).toBe('json');
    expect(editorLanguageFor('responseMapping', 'json', {})).toBe('json');
    expect(editorLanguageFor('anything-at-all', 'json', {})).toBe('json');
  });

  it('knows a query is SQL and html is html', () => {
    expect(editorLanguageFor('query', 'textarea', {})).toBe('sql');
    expect(editorLanguageFor('html', 'textarea', {})).toBe('html');
  });

  it('falls back to plain text rather than guessing', () => {
    // `template` and `text` could be anything. A wrong grammar colours code as
    // if it were wrong, which is worse than no colour at all.
    expect(editorLanguageFor('template', 'textarea', {})).toBe('text');
    expect(editorLanguageFor('text', 'textarea', {})).toBe('text');
    expect(editorLanguageFor('whatever', 'textarea', {})).toBe('text');
  });

  it('ignores a language value it does not recognise', () => {
    expect(editorLanguageFor('code', 'textarea', { language: 'brainfuck' })).toBe('javascript');
  });
});
