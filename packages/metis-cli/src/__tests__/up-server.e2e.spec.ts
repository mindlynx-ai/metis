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
 * `metis up` is the one long-lived command: it must keep serving until a
 * termination signal, not exit the instant the server is listening. Guards the
 * regression where bin.ts's process.exit(code) tore the server down the moment
 * cmdUp returned. Gated behind METIS_E2E (boots a real Temporal dev server);
 * offset ports so it never clashes with a running stack. Spawned detached so
 * SIGTERM reaches the whole process group (node + the Temporal child).
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const enabled = process.env.METIS_E2E === '1';
const here = fileURLToPath(new URL('.', import.meta.url));
const bin = resolve(here, '..', 'bin.ts');
// Run bin.ts through tsx resolved by absolute path, so the child's cwd (a temp
// project dir with no node_modules) does not have to resolve the tsx loader.
const require = createRequire(import.meta.url);
const tsxCli = join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const EDITOR = 13100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function serves(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${EDITOR}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'admin', secret: 'metis' }),
      signal: AbortSignal.timeout(2000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

describe.skipIf(!enabled)('metis up stays alive until a signal (METIS_E2E)', () => {
  it('keeps serving after listen and shuts down on SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-up-server-'));
    writeFileSync(
      join(dir, 'metis.config.json'),
      JSON.stringify({
        datastore: 'sqlite',
        ports: { editor: EDITOR, temporalGrpc: 17255, temporalUi: 18255 },
        paths: { data: '.metis', database: '.metis/metis.db' },
      }),
    );

    const child = spawn(process.execPath, [tsxCli, bin, 'up'], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
    });

    try {
      let up = false;
      for (let i = 0; i < 90 && !up; i += 1) {
        up = await serves();
        if (!up) await sleep(1000);
      }
      expect(up, 'metis up should come up and serve').toBe(true);

      // The regression: it must STILL be serving a few seconds later. The old
      // bug exited (process.exit(0)) the instant the server was listening.
      await sleep(3000);
      expect(await serves(), 'metis up should stay up, not exit after listen').toBe(true);
      expect(child.exitCode, 'the process should still be running').toBeNull();
    } finally {
      // Signal the whole group so the Temporal child dies with it.
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }

    let stopped = false;
    for (let i = 0; i < 20 && !stopped; i += 1) {
      stopped = !(await serves());
      if (!stopped) await sleep(1000);
    }
    expect(stopped, 'SIGTERM should stop the server').toBe(true);
  }, 180_000);
});
