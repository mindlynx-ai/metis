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
 * Project scaffolding for `metis init`. Writes a
 * config, a .metis working directory, a .gitignore and a first
 * workflow that runs with no Temporal knowledge. Idempotent: existing
 * files are never overwritten.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface MetisConfig {
  datastore: 'sqlite' | 'postgres';
  ports: { editor: number; temporalGrpc: number; temporalUi: number };
  paths: { data: string; database: string };
  /** How long Metis keeps execution history - the archive outlives
   *  Temporal's own (much shorter) visibility retention. */
  retentionDays?: number;
}

export const DEFAULT_CONFIG: MetisConfig = {
  datastore: 'sqlite',
  ports: { editor: 3000, temporalGrpc: 7233, temporalUi: 8233 },
  paths: { data: '.metis', database: '.metis/metis.db' },
  retentionDays: 90,
};

const SAMPLE_WORKFLOW = {
  workflowId: 'hello',
  name: 'Hello, Metis',
  type: 'workflow',
  definition: {
    nodes: [
      {
        id: 'node-11111111-1111-4111-8111-111111111111',
        type: 'signal',
        label: 'Start',
        config: { signalType: 'manual' },
      },
      {
        id: 'node-22222222-2222-4222-8222-222222222222',
        type: 'code',
        label: 'Say hello',
        config: {
          input: { who: 'world' },
          code: "return { message: `hello from metis, ${input.who}` };",
        },
      },
    ],
    edges: [
      {
        source: 'node-11111111-1111-4111-8111-111111111111',
        target: 'node-22222222-2222-4222-8222-222222222222',
      },
    ],
  },
};

const GITIGNORE = ['.metis/', 'node_modules/', '*.log', ''].join('\n');

export interface ScaffoldResult {
  created: string[];
  skipped: string[];
}

function writeIfAbsent(
  path: string,
  contents: string,
  result: ScaffoldResult,
  label: string,
): void {
  if (existsSync(path)) {
    result.skipped.push(label);
    return;
  }
  writeFileSync(path, contents);
  result.created.push(label);
}

export function scaffoldProject(cwd: string): ScaffoldResult {
  const result: ScaffoldResult = { created: [], skipped: [] };
  mkdirSync(join(cwd, '.metis'), { recursive: true });
  mkdirSync(join(cwd, 'workflows'), { recursive: true });

  writeIfAbsent(
    join(cwd, 'metis.config.json'),
    `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`,
    result,
    'metis.config.json',
  );
  writeIfAbsent(join(cwd, '.gitignore'), GITIGNORE, result, '.gitignore');
  writeIfAbsent(
    join(cwd, 'workflows', 'hello.json'),
    `${JSON.stringify(SAMPLE_WORKFLOW, null, 2)}\n`,
    result,
    'workflows/hello.json',
  );
  return result;
}
