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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const tokensCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'design', 'tokens.css'),
  'utf8',
);

function themeTokens(theme: 'light' | 'dark'): Record<string, string> {
  const marker = theme === 'light' ? ":root,\n[data-theme='light'] {" : "[data-theme='dark'] {";
  const start = tokensCss.indexOf(marker);
  const end = tokensCss.indexOf('}', tokensCss.indexOf('--shadow-soft', start));
  const block = tokensCss.slice(start, end);
  const tokens: Record<string, string> = {};
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('--') || !line.endsWith(';')) continue;
    const colon = line.indexOf(': ');
    if (colon < 0) continue;
    const value = line.slice(colon + 2, -1).trim();
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      tokens[line.slice(0, colon)] = value;
    }
  }
  return tokens;
}

function luminance(hex: string): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  const r = channel(Number.parseInt(hex.slice(1, 3), 16));
  const g = channel(Number.parseInt(hex.slice(3, 5), 16));
  const b = channel(Number.parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [lighter, darker] = la > lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

/** [foreground token, background token, minimum ratio] */
const TEXT_PAIRS: [string, string, number][] = [
  ['--text-primary', '--surface-base', 4.5],
  ['--text-primary', '--surface-raised', 4.5],
  ['--text-primary', '--surface-canvas', 4.5],
  ['--text-muted', '--surface-base', 4.5],
  ['--text-muted', '--surface-raised', 4.5],
  ['--text-faint', '--surface-base', 4.5],
  ['--brand', '--surface-base', 4.5],
  ['--brand', '--brand-wash', 4.5],
  ['--on-brand', '--brand', 4.5],
  ['--on-accent', '--accent', 4.5],
  ['--accent-text', '--surface-base', 4.5],
  ['--accent-text', '--surface-sunken', 4.5],
  ['--danger-text', '--surface-base', 4.5],
  ['--success-text', '--surface-base', 4.5],
  ['--warning-text', '--surface-base', 4.5],
  ['--warning-text', '--surface-raised', 4.5],
  ['--cat-trigger-text', '--cat-trigger-wash', 4.5],
  ['--cat-logic-text', '--cat-logic-wash', 4.5],
  ['--cat-transform-text', '--cat-transform-wash', 4.5],
  ['--cat-integration-text', '--cat-integration-wash', 4.5],
  ['--status-cancelled', '--surface-raised', 4.5],
  ['--focus-ring', '--surface-base', 3],
  ['--focus-ring', '--surface-canvas', 3],
  // The Sky set (cloud affordances + the degraded modifier).
  ['--cloud-text', '--surface-base', 4.5],
  ['--cloud-text', '--surface-raised', 4.5],
  ['--cloud-text', '--cloud-wash', 4.5],
  ['--cloud-dot', '--surface-raised', 3],
  ['--status-degraded', '--surface-base', 4.5],
  ['--status-degraded', '--surface-raised', 4.5],
];

describe.each(['light', 'dark'] as const)('token contrast, %s theme (WCAG AA)', (theme) => {
  const tokens = themeTokens(theme);

  it('parses the theme block', () => {
    expect(Object.keys(tokens).length).toBeGreaterThan(20);
  });

  it.each(TEXT_PAIRS)('%s on %s reaches %s:1', (fg, bg, minimum) => {
    const fgHex = tokens[fg];
    const bgHex = tokens[bg];
    expect(fgHex, `${fg} missing in ${theme}`).toBeDefined();
    expect(bgHex, `${bg} missing in ${theme}`).toBeDefined();
    const ratio = contrastRatio(fgHex ?? '#000000', bgHex ?? '#ffffff');
    expect(
      ratio,
      `${theme}: ${fg} (${fgHex}) on ${bg} (${bgHex}) is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(minimum);
  });
});
