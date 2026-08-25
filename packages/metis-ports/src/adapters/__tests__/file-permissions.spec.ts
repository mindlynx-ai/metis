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
 * Keeping the vault key to its owner, on both kinds of filesystem.
 *
 * `chmod 0600` is a silent NO-OP on Windows - Node implements only the
 * read-only bit there - so the key to every stored credential inherited
 * whatever the containing folder allowed. SECURITY.md documented that as a
 * known gap for as long as Windows was unsupported. It is supported now.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerOnlyArgs, restrictToOwner } from '../file-permissions.js';

describe('the Windows ACL', () => {
  it('strips inheritance and grants exactly one account', () => {
    const args = ownerOnlyArgs('C:\\metis\\.metis\\credential.key', 'DOMAIN\\jeremy');
    // /inheritance:r is the important half: without it the file keeps whatever
    // the parent folder hands out, and granting the owner changes nothing.
    expect(args).toEqual([
      'C:\\metis\\.metis\\credential.key',
      '/inheritance:r',
      '/grant:r',
      'DOMAIN\\jeremy:F',
    ]);
  });

  it('quotes nothing itself, because it is never run through a shell', () => {
    const args = ownerOnlyArgs('C:\\Users\\Jeremy Snyman\\key', 'Jeremy Snyman');
    // A path with a space stays ONE argument. Quoting it here would make icacls
    // look for a file whose name contains quote marks.
    expect(args[0]).toBe('C:\\Users\\Jeremy Snyman\\key');
    expect(args[3]).toBe('Jeremy Snyman:F');
  });
});

describe.skipIf(process.platform === 'win32')('on a POSIX filesystem', () => {
  it('leaves the file readable only by its owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-perm-'));
    const file = join(dir, 'credential.key');
    // Deliberately world-readable to start with, so a no-op would be visible.
    writeFileSync(file, 'secret', { mode: 0o644 });

    restrictToOwner(file);

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('does not throw on a file that has gone', () => {
    // Called from cleanup paths; a missing file is not worth failing a boot for.
    expect(() => restrictToOwner(join(tmpdir(), 'metis-perm-absent', 'nope'))).not.toThrow();
  });
});
