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
 * The real download-and-boot check, gated behind METIS_E2E so
 * it only runs where a network and spare ports are available (CI). It
 * downloads the pinned dev-server binary, verifies it, boots it on
 * ephemeral ports and confirms the gRPC frontend accepts connections.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binaryName, defaultEnsureDeps, ensureTemporalBinary } from '../download.js';
import { TemporalDevServer, waitForPort } from '../dev-server.js';

const enabled = process.env.METIS_E2E === '1';

describe.skipIf(!enabled)('Temporal dev server real boot (METIS_E2E)', () => {
  it('downloads, verifies, boots and shuts down cleanly', async () => {
    const home = mkdtempSync(join(tmpdir(), 'metis-boot-home-'));
    const project = mkdtempSync(join(tmpdir(), 'metis-boot-project-'));

    // defaultEnsureDeps, not a copy of it. This spec used to carry its own
    // fetch-and-extract pair, which meant the one test that claims to prove the
    // real download proved a parallel implementation instead - and that copy
    // hardcoded /usr/bin/tar and an extensionless binary name, so it could only
    // ever pass on POSIX. The Windows job caught it on its first run.
    const binary = await ensureTemporalBinary({ home, ...defaultEnsureDeps() });
    expect(binary).toContain(binaryName());

    const server = new TemporalDevServer({
      binaryPath: binary,
      grpcPort: 17233,
      uiPort: 18233,
      databaseFile: join(project, '.metis', 'temporal.db'),
      pidFile: join(project, '.metis', 'temporal.pid'),
    });
    await server.start();
    // start() already probed readiness; this second probe asserts the
    // frontend genuinely accepts a fresh connection.
    await expect(waitForPort(17233, '127.0.0.1', 5_000)).resolves.toBeUndefined();
    await server.stop();
  }, 180_000);
});
