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
import { describe, it, expect } from 'vitest';
import { parseGuide } from '../builder/inspector/GuidePanel.js';

describe('parseGuide (the Guide tab markdown subset)', () => {
  it('parses headings, paragraphs and lists', () => {
    const blocks = parseGuide('## What it is\nOne line.\nStill one paragraph.\n\n- first\n- second\n\nAfter.');
    expect(blocks).toEqual([
      { kind: 'heading', text: 'What it is' },
      { kind: 'paragraph', text: 'One line. Still one paragraph.' },
      { kind: 'list', items: ['first', 'second'] },
      { kind: 'paragraph', text: 'After.' },
    ]);
  });

  it('a list directly after a paragraph flushes the paragraph first', () => {
    const blocks = parseGuide('Intro:\n- a\n- b');
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'list']);
  });
});
