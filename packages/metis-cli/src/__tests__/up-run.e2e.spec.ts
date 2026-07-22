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
 * init, up and run on a machine with no Temporal, gated
 * behind METIS_E2E because it downloads and boots the real dev server.
 * The runtime uses ports offset from the defaults so it never collides
 * with a developer's running stack.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';

const enabled = process.env.METIS_E2E === '1';

describe.skipIf(!enabled)('metis init then up then run (METIS_E2E)', () => {
  it('runs the scaffolded workflow to completion with no Temporal preinstalled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-up-run-'));
    const lines: string[] = [];
    const io = {
      cwd: dir,
      stdout: (line: string) => lines.push(line),
      stderr: (line: string) => lines.push(line),
    };

    expect(await runCli(['init'], io)).toBe(0);

    // Offset the ports so the harness never clashes with a live stack.
    const configPath = join(dir, 'metis.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      ports: { editor: number; temporalGrpc: number; temporalUi: number };
    };
    config.ports = { editor: 13000, temporalGrpc: 17244, temporalUi: 18244 };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const code = await runCli(['run', 'hello'], io);
    const output = lines.join('\n');
    expect(output, output).toContain('status: completed');
    expect(output).toContain('hello from metis');
    expect(code).toBe(0);
  }, 180_000);
});
