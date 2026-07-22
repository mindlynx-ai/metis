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
 * The full-run harness: a real Metis runtime (Temporal dev server plus
 * worker) behind the control server on 4181, so the browser e2e can
 * build a workflow, run it and see it complete for real.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetisRuntime } from '../../metis-cli/src/runtime.js';
import { buildControlServer } from '../../metis-cli/src/control-server.js';
import { DEFAULT_CONFIG } from '../../metis-cli/src/scaffold.js';

const projectDir = mkdtempSync(join(tmpdir(), 'metis-full-e2e-'));
const config = {
  ...DEFAULT_CONFIG,
  ports: { editor: 4182, temporalGrpc: 17255, temporalUi: 18255 },
  paths: { data: '.metis', database: '.metis/metis.db' },
};

const runtime = new MetisRuntime({
  projectDir,
  config,
  log: (line) => process.stdout.write(`${line}\n`),
});

await runtime.start();
const app = await buildControlServer({ runtime });
await app.listen({ port: 4181, host: '127.0.0.1' });
process.stdout.write('metis full-run control plane ready on 4181\n');
