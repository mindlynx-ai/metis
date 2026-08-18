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
 * The contributor dev loop: the API on 4181 and the editor on 4180, together.
 *
 * A node script rather than a one-liner because `a & b` does not background on
 * Windows cmd.exe, which is what npm runs scripts through there - and the whole
 * point of this file is that the loop works everywhere. That also rules out
 * adding `concurrently` for two child processes.
 *
 * WHAT THIS IS NOT: the API here is dev-core, whose ExecutionPort is a stub.
 * Workflows APPEAR to run and never touch Temporal. That is the right trade for
 * editor work and the wrong one for engine work - use `metis up` for that.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Vite's entry script, resolved rather than spawned by name.
 *
 * `vite` and `npm` are .cmd shims on Windows, so spawning either by name needs
 * shell:true - and a shell plus paths that can contain spaces is how command
 * injection gets in. Both halves run under this same node instead.
 *
 * The path comes from vite's own `bin` field because `vite/bin/vite.js` is not
 * in its `exports` map and resolving it directly throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED. `./package.json` is exported, so this route
 * survives vite reorganising its dist.
 */
const vitePackage = require.resolve('vite/package.json');
const vite = join(dirname(vitePackage), require(vitePackage).bin.vite);

const children = [
  ['api', [process.cwd(), '--import', 'tsx', 'packages/metis-editor/e2e/dev-core.ts']],
  ['web', ['packages/metis-editor', vite]],
].map(([label, [cwd, ...args]]) => {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('exit', (code, signal) => {
    process.stdout.write(`\n${label} exited (${signal ?? code}). Stopping the other half.\n`);
    stop();
    process.exitCode = code ?? 1;
  });
  return child;
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

process.stdout.write('editor http://127.0.0.1:4180  API http://127.0.0.1:4181\n');
process.stdout.write('Runs are STUBBED on this loop - use `metis up` for real ones.\n');
