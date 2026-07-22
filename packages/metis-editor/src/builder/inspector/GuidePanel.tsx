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
 * The Guide tab: the node's long-form documentation ("what is it, how does it
 * work"), authored as a `docs` markdown field on the catalogue entry. Rendered
 * by a deliberately tiny line-based markdown subset (headings, lists,
 * paragraphs, `code` and **bold** inline) - no renderer dependency, no HTML
 * injection.
 */
import type { ReactNode } from 'react';

export type GuideBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'paragraph'; text: string };

/** Parse the markdown subset into blocks (pure; unit-tested). */
export function parseGuide(markdown: string): GuideBlock[] {
  const blocks: GuideBlock[] = [];
  let list: string[] | null = null;
  let paragraph: string[] = [];
  const flush = () => {
    if (list) {
      blocks.push({ kind: 'list', items: list });
      list = null;
    }
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
      paragraph = [];
    }
  };
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) {
      flush();
      blocks.push({ kind: 'heading', text: line.slice(3) });
    } else if (line.startsWith('- ')) {
      if (paragraph.length > 0) flush();
      if (!list) list = [];
      list.push(line.slice(2));
    } else if (line.trim() === '') {
      flush();
    } else {
      if (list) flush();
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

/** Inline `code` and **bold** within a text run. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code className="mono" key={index}>
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

export function GuidePanel({ markdown }: { markdown: string }) {
  return (
    <div className="guide-panel">
      {parseGuide(markdown).map((block, index) => {
        if (block.kind === 'heading') return <h4 key={index}>{block.text}</h4>;
        if (block.kind === 'list') {
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{inline(item)}</li>
              ))}
            </ul>
          );
        }
        return <p key={index}>{inline(block.text)}</p>;
      })}
    </div>
  );
}
