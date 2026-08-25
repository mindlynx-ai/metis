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
 * Keep a file to the account that owns it, on whichever filesystem this is.
 *
 * `chmod(0600)` is a silent no-op on Windows: Node implements only the
 * read-only bit there, so the mode argument is accepted and ignored. That left
 * the credential vault and the 32-byte key beside it inheriting the containing
 * folder's ACL - on a default user profile, readable by administrators and by
 * anything else running as that user. The encryption was never the weak part;
 * the permission layer underneath it simply was not there.
 *
 * Windows has no ACL API in Node, so this shells to `icacls`, the tool that
 * ships with the OS. Resolved by name with no shell, like every other spawn in
 * this repository.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { userInfo } from 'node:os';

/**
 * The icacls arguments that leave exactly one account with access.
 *
 * `/inheritance:r` first and last: removing inherited entries is the half that
 * matters. Granting the owner alone achieves nothing while the parent folder is
 * still handing out rights to everybody.
 *
 * Nothing is quoted here. These go to spawn as separate arguments with no shell
 * in between, so a path containing a space is already one argument; adding
 * quotes would make icacls look for a filename that contains quote marks.
 */
export function ownerOnlyArgs(path: string, account: string): string[] {
  return [path, '/inheritance:r', '/grant:r', `${account}:F`];
}

/**
 * Restrict a file to its owner. Best effort by design.
 *
 * @param path - the file, which must already exist.
 * @param platform - overridable for tests.
 * @returns whether the restriction was applied.
 */
export function restrictToOwner(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    if (platform !== 'win32') {
      chmodSync(path, 0o600);
      return true;
    }
    // icacls lives in %SystemRoot%\\System32, which is on PATH on every Windows
    // install and is not user-writeable. Resolving it through PATH is the same
    // trade the Temporal extractor makes for `tar`, and hardcoding the System32
    // path would break on a machine that relocated its Windows directory.
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const result = spawnSync('icacls', ownerOnlyArgs(path, userInfo().username), {
      shell: false,
      stdio: 'ignore',
      timeout: 10_000,
    });
    return result.status === 0;
  } catch {
    // A missing file is the common case (cleanup paths, a vault not written
    // yet) and is not worth failing a boot over. A genuine refusal is reported
    // by the return value, which the caller warns about rather than throwing:
    // an operator who cannot tighten a file still needs their Metis to start.
    return false;
  }
}
