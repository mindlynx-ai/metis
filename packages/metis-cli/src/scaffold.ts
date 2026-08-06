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
 * The project config, and the scaffolding that writes a first one. `metis init`
 * lays down a config, a .metis working directory, a .gitignore and a first
 * workflow that runs with no Temporal knowledge; it is idempotent, so existing
 * files are never overwritten. Reading that config back is parseConfig, which
 * lives here because it is defined against DEFAULT_CONFIG.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** One declaration of the config shape, so the validator and the type cannot
 *  drift apart. */
export const MetisConfigSchema = z.object({
  datastore: z.enum(['sqlite', 'postgres']),
  ports: z.object({
    editor: z.number().int().positive(),
    temporalGrpc: z.number().int().positive(),
    temporalUi: z.number().int().positive(),
  }),
  paths: z.object({ data: z.string().min(1), database: z.string().min(1) }),
  /** How long Metis keeps execution history - the archive outlives
   *  Temporal's own (much shorter) visibility retention. */
  retentionDays: z.number().int().positive().optional(),
  /** Sign-in policy. Yours to set, because Metis is yours to run - but see
   *  DEFAULT_CONFIG: the defaults are deliberately not "never expires". */
  auth: z.object({
    /** Hard ceiling on a session, from sign-in. Use does not extend it. */
    sessionAbsoluteHours: z.number().positive(),
    /** Silence that ends a session early. Below the absolute one, or inert. */
    sessionIdleHours: z.number().positive(),
    /** Live sessions held in memory before the oldest is dropped. */
    maxSessions: z.number().int().positive(),
    /** Failed sign-ins allowed per window, per source address + username. */
    loginAttempts: z.number().int().positive(),
    /** How long that window lasts. */
    loginWindowMinutes: z.number().positive(),
  }),
});

export type MetisConfig = z.infer<typeof MetisConfigSchema>;

/**
 * `auth` restates DEFAULT_SESSION_POLICY (metis-ports) and DEFAULT_LOGIN_LIMIT
 * (metis-core) rather than importing them: this module is on `metis init`'s
 * path, and importing metis-core would drag Fastify into a command that only
 * writes four files. A test asserts the two sets are equal, so they cannot
 * drift apart in silence.
 */
export const DEFAULT_CONFIG: MetisConfig = {
  datastore: 'sqlite',
  ports: { editor: 3000, temporalGrpc: 7233, temporalUi: 8233 },
  paths: { data: '.metis', database: '.metis/metis.db' },
  retentionDays: 90,
  auth: {
    sessionAbsoluteHours: 24,
    sessionIdleHours: 8,
    maxSessions: 10_000,
    loginAttempts: 10,
    loginWindowMinutes: 15,
  },
};

/** One level of the config, defaults underneath whatever the file says. A value
 *  that is not an object at all is handed straight to the schema, so
 *  `"ports": 3000` is named rather than silently replaced by the defaults. */
function overlay<T extends object>(base: T, over: unknown): unknown {
  if (over === undefined || over === null) return base;
  if (typeof over !== 'object' || Array.isArray(over)) return over;
  return { ...base, ...over };
}

/**
 * Merge a config file over the defaults, then validate.
 *
 * The file is PARTIAL by design: moving a clashing port is the one thing an
 * operator is told to write `metis.config.json` for, and nobody doing that
 * should have to restate the datastore and both paths as well. Before this it
 * was parsed and cast, so a ports-only file reached the runtime with no `paths`
 * and boot died on "Cannot read properties of undefined (reading 'database')".
 * The documented cure for a port clash bricked the product.
 *
 * Two levels deep is the whole shape, so the merge is written out rather than
 * made generic.
 */
export function parseConfig(raw: unknown, source: string): MetisConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${source}: expected a JSON object`);
  }
  const partial = raw as Record<string, unknown>;
  const parsed = MetisConfigSchema.safeParse({
    ...DEFAULT_CONFIG,
    ...partial,
    ports: overlay(DEFAULT_CONFIG.ports, partial.ports),
    paths: overlay(DEFAULT_CONFIG.paths, partial.paths),
    auth: overlay(DEFAULT_CONFIG.auth, partial.auth),
  });
  if (parsed.success) return parsed.data;
  // Name the offending key. A validation failure the operator cannot locate is
  // barely better than the TypeError it replaces.
  const issue = parsed.error.issues[0];
  const where = issue.path.length > 0 ? issue.path.join('.') : 'config';
  throw new Error(`${source}: ${where} is invalid (${issue.message.toLowerCase()})`);
}

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
