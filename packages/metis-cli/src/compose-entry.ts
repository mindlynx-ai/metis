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
 * The compose image entrypoint. Connects to the compose
 * Temporal service (no dev-server download in the container) and
 * serves the editor and API on port 3000, with SQLite in the mounted
 * data volume.
 */
import { join } from 'node:path';
import { MetisRuntime } from './runtime.js';
import { buildControlServer } from './control-server.js';
import { seedConnectorsIfEmpty } from './connectors.js';
import { DEFAULT_CONFIG } from './scaffold.js';

const dataDir = process.env.METIS_DATA_DIR ?? '/data';
const temporalAddress = process.env.METIS_TEMPORAL_ADDRESS ?? 'temporal:7233';

const config = {
  ...DEFAULT_CONFIG,
  paths: { data: dataDir, database: join(dataDir, 'metis.db') },
};

const log = (line: string) => process.stdout.write(`${line}\n`);

const runtime = new MetisRuntime({
  projectDir: dataDir,
  config,
  log,
  externalTemporalAddress: temporalAddress,
});

await runtime.start();
// Seed the connector registry so connector node types can resolve their base
// URL, auth scheme and operations at run time (the CLI `up` path does the same;
// the compose entry must too, else every connector node 404s). Idempotent:
// only seeds when the registry is empty.
const seeded = await seedConnectorsIfEmpty(runtime.connectors);
if (seeded) log(`Seeded ${seeded.seeded} connectors into the catalogue.`);
const app = await buildControlServer({
  runtime,
  editorDir: join(process.cwd(), 'packages', 'metis-editor', 'dist'),
});
await app.listen({ port: config.ports.editor, host: '0.0.0.0' });
log(`Metis is up. Editor and API on port ${config.ports.editor}.`);

const shutdown = () => {
  app
    .close()
    .then(() => runtime.stop())
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
