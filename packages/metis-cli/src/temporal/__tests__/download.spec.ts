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
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archiveName,
  binaryPath,
  cacheDir,
  downloadUrl,
  ensureTemporalBinary,
  expectedChecksum,
  resolvePlatform,
  sha256,
  TEMPORAL_CLI_VERSION,
} from '../download.js';
import { devServerArgs } from '../dev-server.js';

describe('Temporal binary download resolution', () => {
  it('resolves supported platforms and rejects the rest', () => {
    expect(resolvePlatform('darwin', 'arm64').key).toBe('darwin_arm64');
    expect(resolvePlatform('linux', 'x64').key).toBe('linux_amd64');
    expect(() => resolvePlatform('win32', 'x64')).toThrow(/WSL/);
    expect(() => resolvePlatform('linux', 'riscv')).toThrow(/architecture/);
  });

  it('builds the official release URL and archive name for the pinned version', () => {
    const target = resolvePlatform('linux', 'x64');
    expect(archiveName(target)).toBe(`temporal_cli_${TEMPORAL_CLI_VERSION}_linux_amd64.tar.gz`);
    expect(downloadUrl(target)).toBe(
      `https://github.com/temporalio/cli/releases/download/v${TEMPORAL_CLI_VERSION}/temporal_cli_${TEMPORAL_CLI_VERSION}_linux_amd64.tar.gz`,
    );
    expect(expectedChecksum(target)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('downloads, verifies the checksum, extracts and caches on a miss', async () => {
    const home = mkdtempSync(join(tmpdir(), 'metis-home-'));
    const target = resolvePlatform('linux', 'x64');
    // Build an archive whose sha256 matches a temporary pinned value.
    const fakeArchive = new TextEncoder().encode('pretend-tar-gz');
    const digest = sha256(fakeArchive);
    const { TEMPORAL_CLI_CHECKSUMS } = await import('../download.js');
    const original = TEMPORAL_CLI_CHECKSUMS[target.key];
    TEMPORAL_CLI_CHECKSUMS[target.key] = digest;

    let fetched = 0;
    const bin = await ensureTemporalBinary({
      platform: 'linux',
      arch: 'x64',
      home,
      fetchArchive: async (url) => {
        fetched += 1;
        expect(url).toContain('temporal_cli');
        return fakeArchive;
      },
      extractBinary: async (_archive, destDir) => {
        const path = join(destDir, 'temporal');
        writeFileSync(path, 'binary');
        return path;
      },
    });
    expect(bin).toBe(binaryPath(TEMPORAL_CLI_VERSION, home));
    expect(existsSync(bin)).toBe(true);
    expect(existsSync(join(cacheDir(TEMPORAL_CLI_VERSION, home), 'metis-download.json'))).toBe(true);
    expect(fetched).toBe(1);

    // Cache hit: no second fetch.
    const again = await ensureTemporalBinary({
      platform: 'linux',
      arch: 'x64',
      home,
      fetchArchive: async () => {
        throw new Error('should not fetch on a cache hit');
      },
      extractBinary: async () => {
        throw new Error('should not extract on a cache hit');
      },
    });
    expect(again).toBe(bin);

    TEMPORAL_CLI_CHECKSUMS[target.key] = original ?? digest;
  });

  it('refuses to install a binary whose checksum does not match', async () => {
    const home = mkdtempSync(join(tmpdir(), 'metis-home-'));
    // Pre-create nothing, so it attempts a download with a wrong archive.
    await expect(
      ensureTemporalBinary({
        platform: 'linux',
        arch: 'x64',
        home,
        fetchArchive: async () => new TextEncoder().encode('tampered'),
        extractBinary: async () => {
          throw new Error('extract must not run after a checksum failure');
        },
      }),
    ).rejects.toThrow(/checksum mismatch/i);
    expect(existsSync(binaryPath(TEMPORAL_CLI_VERSION, home))).toBe(false);
  });

  it('a cache hit is honoured even with no network', async () => {
    const home = mkdtempSync(join(tmpdir(), 'metis-home-'));
    mkdirSync(cacheDir(TEMPORAL_CLI_VERSION, home), { recursive: true });
    writeFileSync(binaryPath(TEMPORAL_CLI_VERSION, home), 'cached');
    const bin = await ensureTemporalBinary({
      platform: 'linux',
      arch: 'x64',
      home,
      fetchArchive: async () => {
        throw new Error('offline');
      },
      extractBinary: async () => {
        throw new Error('offline');
      },
    });
    expect(readFileSync(bin, 'utf8')).toBe('cached');
  });
});

describe('dev-server arguments', () => {
  it('starts on the given ports with a persistent db file', () => {
    const args = devServerArgs({
      binaryPath: '/x/temporal',
      grpcPort: 7233,
      uiPort: 8233,
      databaseFile: '/project/.metis/temporal.db',
      pidFile: '/project/.metis/temporal.pid',
    });
    expect(args).toContain('start-dev');
    expect(args.join(' ')).toContain('--port 7233');
    expect(args.join(' ')).toContain('--ui-port 8233');
    expect(args.join(' ')).toContain('--db-filename /project/.metis/temporal.db');
  });
});
