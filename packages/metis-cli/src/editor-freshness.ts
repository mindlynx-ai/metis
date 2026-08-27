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
 * Is the editor bundle we are about to serve older than the code it was built
 * from?
 *
 * This exists because a stale bundle is INVISIBLE. It is a complete, working
 * editor - it just behaves like the day it was built, so every fix since is
 * absent and the reader concludes the fix does not work. It has cost real time
 * twice: once as a Validate button that "was not there", and once as a whole
 * list of bugs re-reported against a build that predated their fix. Neither
 * reader did anything wrong; nothing told them what they were looking at.
 *
 * Two ways to be stale, and they are different mistakes:
 *
 *  - **Pulled without rebuilding.** The source moved and `dist` did not. This
 *    is the `git pull` case, and it is the common one.
 *  - **A copy left behind.** `metis up` serves `<project>/editor`, which people
 *    copy from `packages/metis-editor/dist` once and forget. A later rebuild
 *    updates the original and never the copy.
 *
 * MTIMES, not a build stamp. A stamp is another artifact to write, keep in
 * sync and explain, and it would tell us nothing the file times do not: a
 * checkout writes the files it changes, so after a pull the changed source IS
 * newer than the bundle. The one thing to know is that this is a HINT and is
 * written as one - a warning that names the fix, never a refusal. Being wrong
 * about staleness must not stop somebody working.
 */
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

/** Where the editor's source lives, relative to a source checkout's root. */
const EDITOR_SRC = join('packages', 'metis-editor', 'src');
/** The bundle a source checkout builds, which a copied `editor/` drifts from. */
const EDITOR_DIST = join('packages', 'metis-editor', 'dist');

/**
 * The newest mtime under a directory, or 0 when it is absent or unreadable.
 *
 * Depth-limited rather than unbounded: the answer only has to be "did anything
 * here move", and a runaway walk on somebody's node_modules symlink would turn
 * a hint into a hang at boot.
 */
export function newestMtime(dir: string, depth = 6): number {
  if (depth < 0 || !existsSync(dir)) return 0;
  let newest = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      newest = Math.max(
        newest,
        entry.isDirectory() ? newestMtime(path, depth - 1) : statSync(path).mtimeMs,
      );
    } catch {
      // A file that vanished mid-walk tells us nothing; keep going.
    }
  }
  return newest;
}

/** When the served bundle was built: its entry file is written last enough. */
function builtAt(editorDir: string): number {
  const index = join(editorDir, 'index.html');
  try {
    return existsSync(index) ? statSync(index).mtimeMs : 0;
  } catch {
    return 0;
  }
}

export interface EditorFreshness {
  /** When the served bundle was built, or 0 when that cannot be read. */
  builtAt: number;
  /** Why it looks stale, in the words the reader needs. Absent when it is fine. */
  staleReason?: string;
}

/**
 * Judge the bundle at `editorDir`, from a checkout rooted at `cwd`.
 *
 * Silent unless it can prove staleness: with no source tree beside it (an
 * installed package, the compose image) there is nothing to compare against,
 * and inventing a warning there would train people to ignore this one.
 *
 * @param cwd - where `metis up` was run
 * @param editorDir - the bundle it resolved to serve
 * @returns when it was built, and why it looks stale if it does
 */
export function editorFreshness(cwd: string, editorDir: string): EditorFreshness {
  const built = builtAt(editorDir);
  if (built === 0) return { builtAt: 0 };

  const sourceAt = newestMtime(join(cwd, EDITOR_SRC));
  if (sourceAt > built) {
    return {
      builtAt: built,
      staleReason:
        'the editor source has changed since this bundle was built, so you are '
        + 'looking at the older one. `npm run build` rebuilds it.',
    };
  }

  // The copied-and-forgotten case. Only when the copy is NOT the original.
  const dist = join(cwd, EDITOR_DIST);
  if (editorDir !== dist) {
    const distAt = builtAt(dist);
    if (distAt > built) {
      return {
        builtAt: built,
        staleReason:
          `a newer editor build exists at ${EDITOR_DIST}. This directory is a `
          + 'copy that was not refreshed; copy it again to pick the new one up.',
      };
    }
  }

  return { builtAt: built };
}

/** "3 days ago" - enough for somebody to notice a bundle is not from today. */
export function describeAge(builtAtMs: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - builtAtMs) / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}
