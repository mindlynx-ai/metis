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
 * The icon set is a plain map of SVG path data - no icon library. Every path
 * must be valid path data (starts with a moveto, uses only path characters)
 * so a typo cannot ship a blank icon.
 */
import { describe, it, expect } from 'vitest';
import { ICON_PATHS } from '../ui/Icon.js';

describe('icon paths', () => {
  it('every icon is non-empty, starts with a moveto and uses only path data characters', () => {
    const names = Object.keys(ICON_PATHS);
    expect(names.length).toBeGreaterThanOrEqual(14);
    for (const [name, d] of Object.entries(ICON_PATHS)) {
      expect(d, name).toMatch(/^[Mm]/);
      expect(d, name).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9\s.,-]+$/);
    }
  });

  it('covers the names the app relies on', () => {
    for (const name of ['plus', 'play', 'trash', 'check', 'x', 'clock', 'list', 'grid', 'alert', 'refresh', 'info', 'search', 'plug', 'pencil']) {
      expect(ICON_PATHS[name as keyof typeof ICON_PATHS], name).toBeTruthy();
    }
  });
});
