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
 * A stale editor bundle is invisible: it is a complete, working editor that
 * behaves like the day it was built. It has cost real time twice - a Validate
 * button that "was not there", and a whole list of bugs re-reported against a
 * build that predated their fix.
 *
 * These cases pin the two ways to be stale, and the two ways NOT to cry wolf.
 * The second half matters as much as the first: a warning that fires when
 * nothing is wrong is one people learn to scroll past.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeAge, editorFreshness } from '../editor-freshness.js';

let root: string;

/** Write a file and pin its mtime, so "newer" is a fact and not a race. */
function put(path: string, ageMinutes: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x');
  const when = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(path, when, when);
}

const SRC = join('packages', 'metis-editor', 'src');
const DIST = join('packages', 'metis-editor', 'dist');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metis-fresh-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('editorFreshness', () => {
  it('says nothing when the bundle is newer than the source', () => {
    put(join(root, SRC, 'app.tsx'), 120);
    put(join(root, DIST, 'index.html'), 5);

    const result = editorFreshness(root, join(root, DIST));

    expect(result.staleReason).toBeUndefined();
    expect(result.builtAt).toBeGreaterThan(0);
  });

  it('warns when the source moved after the build - the git pull case', () => {
    put(join(root, DIST, 'index.html'), 120);
    put(join(root, SRC, 'app.tsx'), 5);

    const result = editorFreshness(root, join(root, DIST));

    expect(result.staleReason).toContain('source has changed');
    // The warning has to carry the fix, or it is only bad news.
    expect(result.staleReason).toContain('npm run build');
  });

  it('warns when a COPY has been left behind by a later build', () => {
    // `metis up` serves <project>/editor, which people copy once and forget.
    put(join(root, SRC, 'app.tsx'), 300);
    put(join(root, 'editor', 'index.html'), 200);
    put(join(root, DIST, 'index.html'), 5);

    const result = editorFreshness(root, join(root, 'editor'));

    expect(result.staleReason).toContain('newer editor build exists');
    expect(result.staleReason).toContain('copy it again');
  });

  it('does NOT call the original dist a stale copy of itself', () => {
    put(join(root, SRC, 'app.tsx'), 300);
    put(join(root, DIST, 'index.html'), 5);
    expect(editorFreshness(root, join(root, DIST)).staleReason).toBeUndefined();
  });

  it('stays silent with no source beside it - an install, or the compose image', () => {
    // Nothing to compare against. Inventing a warning here is how people learn
    // to ignore the one that matters.
    put(join(root, 'editor', 'index.html'), 9_000);

    const result = editorFreshness(root, join(root, 'editor'));

    expect(result.staleReason).toBeUndefined();
    expect(result.builtAt).toBeGreaterThan(0);
  });

  it('reports nothing at all when there is no bundle to judge', () => {
    expect(editorFreshness(root, join(root, 'editor'))).toEqual({ builtAt: 0 });
  });
});

describe('describeAge', () => {
  const now = Date.now();

  it('reads as a person would say it', () => {
    expect(describeAge(now, now)).toBe('just now');
    expect(describeAge(now - 20 * 60_000, now)).toBe('20 minutes ago');
    expect(describeAge(now - 60 * 60_000, now)).toBe('1 hour ago');
    expect(describeAge(now - 5 * 60 * 60_000, now)).toBe('5 hours ago');
    expect(describeAge(now - 3 * 24 * 60 * 60_000, now)).toBe('3 days ago');
  });

  it('never reads as the future when a clock disagrees', () => {
    expect(describeAge(now + 60_000, now)).toBe('just now');
  });
});
