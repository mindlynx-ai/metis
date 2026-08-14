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

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPortOpen, TemporalDevServer } from '../dev-server.js';

/** A real listener on an OS-assigned port, so nothing races a fixed number. */
async function listen(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
  return { server, port };
}

let open: { server: Server; port: number } | undefined;
afterEach(async () => {
  if (open) await new Promise((resolve) => open!.server.close(resolve));
  open = undefined;
});

describe('the port a stranger already holds', () => {
  it('reports an occupied port as open and a free one as closed', async () => {
    open = await listen();
    expect(await isPortOpen(open.port)).toBe(true);
    const { port: freed } = open;
    await new Promise((resolve) => open!.server.close(resolve));
    open = undefined;
    expect(await isPortOpen(freed)).toBe(false);
  });

  it('refuses to start rather than adopting a Temporal it did not launch', async () => {
    // The regression: `temporal server start-dev` logs the bind failure and
    // keeps running, so the readiness probe used to connect to the OTHER
    // server and call that a successful start. binaryPath is deliberately
    // nonsense - if the guard ever stops firing, the spawn is what fails, and
    // the assertion on the message catches that substitution.
    open = await listen();
    const dir = mkdtempSync(join(tmpdir(), 'metis-devserver-'));
    const server = new TemporalDevServer({
      binaryPath: '/nonexistent/temporal',
      grpcPort: open.port,
      uiPort: 8233,
      databaseFile: join(dir, '.metis', 'temporal.db'),
      pidFile: join(dir, '.metis', 'temporal.pid'),
    });

    await expect(server.start()).rejects.toThrow(
      /already listening on port .*will not attach to a Temporal it did not start/s,
    );
    // It must bail before it spawns anything or leaves state behind.
    expect(existsSync(join(dir, '.metis', 'temporal.pid'))).toBe(false);
  });
});
