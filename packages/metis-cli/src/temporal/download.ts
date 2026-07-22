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
 * Temporal dev-server binary management. The version and the
 * per-platform sha256 table are pinned here; the binary is downloaded
 * from the official GitHub release, verified against the pinned hash
 * before it is ever executed, and cached under ~/.metis/bin. The user
 * never installs Temporal by hand.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TEMPORAL_CLI_VERSION = '1.4.1';

/** sha256 of temporal_cli_{version}_{os}_{arch}.tar.gz (official release). */
export const TEMPORAL_CLI_CHECKSUMS: Record<string, string> = {
  'darwin_amd64': '99e9188952b3cbd4775c0012c210d3f42d5035cd39ca49676ae18c15e9107d3c',
  'darwin_arm64': 'cccbead89534e365a3527d40f6d3370a8fa16af6d7853c9864422fb1f7053fe4',
  'linux_amd64': 'e2063feade24d90cec1590dd9a46b0ccf838433b013738a348af1c01a9cb3874',
  'linux_arm64': '3309f004380edc51ad833937bfd16fe3f2b93aa80f8b46b788de4e371f7628f2',
};

export interface PlatformTarget {
  os: 'darwin' | 'linux';
  arch: 'amd64' | 'arm64';
  key: string;
}

/** Resolve the current platform to a supported target (Windows uses WSL). */
export function resolvePlatform(
  platform: NodeJS.Platform,
  arch: string,
): PlatformTarget {
  let os: 'darwin' | 'linux';
  if (platform === 'darwin') os = 'darwin';
  else if (platform === 'linux') os = 'linux';
  else {
    throw new Error(
      `unsupported platform "${platform}"; run Metis under WSL on Windows (see the README)`,
    );
  }
  let target: 'amd64' | 'arm64';
  if (arch === 'x64' || arch === 'amd64') target = 'amd64';
  else if (arch === 'arm64') target = 'arm64';
  else throw new Error(`unsupported architecture "${arch}"`);
  return { os, arch: target, key: `${os}_${target}` };
}

export function archiveName(target: PlatformTarget, version = TEMPORAL_CLI_VERSION): string {
  return `temporal_cli_${version}_${target.key}.tar.gz`;
}

export function downloadUrl(target: PlatformTarget, version = TEMPORAL_CLI_VERSION): string {
  return `https://github.com/temporalio/cli/releases/download/v${version}/${archiveName(target, version)}`;
}

export function expectedChecksum(target: PlatformTarget): string {
  const checksum = TEMPORAL_CLI_CHECKSUMS[target.key];
  if (!checksum) throw new Error(`no pinned checksum for ${target.key}`);
  return checksum;
}

export function cacheDir(version = TEMPORAL_CLI_VERSION, home = homedir()): string {
  return join(home, '.metis', 'bin', `temporal-${version}`);
}

export function binaryPath(version = TEMPORAL_CLI_VERSION, home = homedir()): string {
  return join(cacheDir(version, home), 'temporal');
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface EnsureDeps {
  fetchArchive(url: string): Promise<Uint8Array>;
  extractBinary(archive: Uint8Array, destDir: string): Promise<string>;
  platform?: NodeJS.Platform;
  arch?: string;
  home?: string;
}

/**
 * Ensure the pinned dev-server binary is present and verified, returning
 * its path. A cache hit skips the download entirely; a checksum mismatch
 * refuses to install the binary.
 */
export async function ensureTemporalBinary(deps: EnsureDeps): Promise<string> {
  const target = resolvePlatform(
    deps.platform ?? process.platform,
    deps.arch ?? process.arch,
  );
  const home = deps.home ?? homedir();
  const destDir = cacheDir(TEMPORAL_CLI_VERSION, home);
  const binPath = binaryPath(TEMPORAL_CLI_VERSION, home);
  if (existsSync(binPath)) return binPath;

  const archive = await deps.fetchArchive(downloadUrl(target));
  const actual = sha256(archive);
  const expected = expectedChecksum(target);
  if (actual !== expected) {
    throw new Error(
      `checksum mismatch for ${archiveName(target)}: expected ${expected}, got ${actual}. Refusing to run an unverified binary.`,
    );
  }
  mkdirSync(destDir, { recursive: true });
  const extracted = await deps.extractBinary(archive, destDir);
  chmodSync(extracted, 0o755);
  // Record what was verified for later audit.
  writeFileSync(
    join(destDir, 'metis-download.json'),
    `${JSON.stringify({ version: TEMPORAL_CLI_VERSION, target: target.key, sha256: actual }, null, 2)}\n`,
  );
  return extracted;
}
