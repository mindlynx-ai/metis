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
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { runCli, loadConfig, loadProjectEnv, resolveTemporalAddress, HELP_TEXT } from '../cli.js';
import { DEFAULT_CONFIG } from '../scaffold.js';
import { DEFAULT_SESSION_POLICY } from '@mindlynx/metis-ports';
import { DEFAULT_LOGIN_LIMIT } from '@mindlynx/metis-core';

const { version: manifestVersion } = createRequire(import.meta.url)('../../package.json') as {
  version: string;
};

function capture() {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), text: () => lines.join('\n') };
}

describe('metis CLI', () => {
  it('prints help for --help and no args', async () => {
    for (const argv of [['--help'], ['-h'], []]) {
      const out = capture();
      const code = await runCli(argv, { cwd: tmpdir(), stdout: out.write, stderr: out.write });
      expect(code).toBe(0);
      expect(out.text()).toContain('metis init');
      expect(out.text()).toContain('metis up');
      expect(out.text()).toContain('metis run');
    }
  });

  it('the help text names every command', () => {
    for (const command of [
      'init',
      'up',
      'run',
      'prune',
      'connectors seed',
      'triggers add',
      'webhooks add',
    ]) {
      expect(HELP_TEXT).toContain(`metis ${command}`);
    }
  });

  it('reports an unknown command as an error', async () => {
    const out = capture();
    const code = await runCli(['wibble'], { cwd: tmpdir(), stdout: out.write, stderr: out.write });
    expect(code).toBe(1);
    expect(out.text()).toMatch(/unknown command/i);
  });

  it('init scaffolds the project layout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-cli-init-'));
    const out = capture();
    const code = await runCli(['init'], { cwd: dir, stdout: out.write, stderr: out.write });
    expect(code).toBe(0);

    expect(existsSync(join(dir, 'metis.config.json'))).toBe(true);
    expect(existsSync(join(dir, '.metis'))).toBe(true);
    expect(existsSync(join(dir, '.gitignore'))).toBe(true);
    expect(existsSync(join(dir, 'workflows', 'hello.json'))).toBe(true);
    // The .env is what makes the first run work on Windows: the documented way
    // to set the one required secret used to be `export`, which cmd.exe and
    // PowerShell do not have.
    expect(existsSync(join(dir, '.env'))).toBe(true);
    const env = readFileSync(join(dir, '.env'), 'utf8');
    expect(env).toContain('METIS_ADMIN_SECRET=');
    // Scaffolded with the DEFAULT, which Metis refuses to serve on, so the
    // first boot stops and says what to change rather than quietly running on a
    // secret published in this repository.
    expect(env).not.toMatch(/^METIS_ADMIN_SECRET=\S/m);

    const config = JSON.parse(readFileSync(join(dir, 'metis.config.json'), 'utf8')) as {
      datastore: string;
      ports: { editor: number; temporalGrpc: number; temporalUi: number };
      auth: Record<string, number>;
    };
    expect(config.datastore).toBe('sqlite');
    expect(config.ports).toEqual({ editor: 3000, temporalGrpc: 7233, temporalUi: 8233 });
    // Written out, not merely defaulted: an operator who cannot see a setting
    // does not have it.
    expect(config.auth).toEqual(DEFAULT_CONFIG.auth);

    const workflow = JSON.parse(readFileSync(join(dir, 'workflows', 'hello.json'), 'utf8')) as {
      workflowId: string;
      definition: { nodes: unknown[]; edges: unknown[] };
    };
    expect(workflow.workflowId).toBe('hello');
    expect(workflow.definition.nodes.length).toBeGreaterThan(0);

    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.metis/');
  });

  it('init is idempotent and does not clobber an edited config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-cli-init-'));
    await runCli(['init'], { cwd: dir, stdout: () => undefined, stderr: () => undefined });
    const before = readFileSync(join(dir, 'metis.config.json'), 'utf8').replace(
      '"sqlite"',
      '"postgres"',
    );
    writeFileSync(join(dir, 'metis.config.json'), before);

    const out = capture();
    const code = await runCli(['init'], { cwd: dir, stdout: out.write, stderr: out.write });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'metis.config.json'), 'utf8')).toContain('"postgres"');
    expect(out.text()).toMatch(/already initialised|already exists/i);
  });
});

const COMMANDS = ['init', 'up', 'run', 'connectors', 'triggers', 'webhooks', 'mcp'] as const;

describe('--help and --version answer without doing the work', () => {
  // "up" is the one that mattered: it used to ignore everything after the
  // command, so asking for help downloaded and booted a Temporal dev server.
  it.each(COMMANDS)('%s --help prints the help and touches nothing', async (command) => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-cli-help-'));
    const out = capture();
    const code = await runCli([command, '--help'], {
      cwd: dir,
      stdout: out.write,
      stderr: out.write,
    });
    expect(code).toBe(0);
    expect(out.text()).toBe(HELP_TEXT);
    // Nothing was scaffolded, no runtime was built and no port was bound. For
    // "up" that is proven twice over: cmdUp's first act is a secret check that
    // throws when METIS_ADMIN_SECRET is unset, as it is here.
    expect(existsSync(join(dir, 'metis.config.json'))).toBe(false);
    expect(existsSync(join(dir, '.metis'))).toBe(false);
  });

  it.each(COMMANDS)('%s --version prints the CLI version', async (command) => {
    const out = capture();
    const code = await runCli([command, '--version'], {
      cwd: tmpdir(),
      stdout: out.write,
      stderr: out.write,
    });
    expect(code).toBe(0);
    expect(out.text()).toBe(`metis ${manifestVersion}`);
  });

  it('honours --help behind a subcommand and its flags', async () => {
    const out = capture();
    const code = await runCli(['triggers', 'add', 'webhook', 'hello', '--help'], {
      cwd: tmpdir(),
      stdout: out.write,
      stderr: out.write,
    });
    expect(code).toBe(0);
    expect(out.text()).toBe(HELP_TEXT);
  });
});

describe('metis.config.json', () => {
  it('takes a ports-only file and fills the rest from the defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-cli-config-'));
    // The documented cure for a port clash. It used to reach the runtime with
    // no `paths` at all and kill the boot on
    // "Cannot read properties of undefined (reading 'database')".
    writeFileSync(join(dir, 'metis.config.json'), JSON.stringify({ ports: { editor: 3100 } }));
    const config = loadConfig(dir);
    expect(config.ports).toEqual({ editor: 3100, temporalGrpc: 7233, temporalUi: 8233 });
    expect(config.paths).toEqual(DEFAULT_CONFIG.paths);
    expect(config.datastore).toBe('sqlite');
  });

  it('uses the defaults when there is no file', () => {
    expect(loadConfig(mkdtempSync(join(tmpdir(), 'metis-cli-config-')))).toEqual(DEFAULT_CONFIG);
  });

  it.each([
    [{ datastore: 'mongo' }, /datastore/],
    [{ ports: { editor: 'three thousand' } }, /ports\.editor/],
    [{ ports: 3000 }, /ports/],
    [{ paths: { database: '' } }, /paths\.database/],
  ])('refuses %j by naming the key', (contents, expected) => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-cli-config-'));
    writeFileSync(join(dir, 'metis.config.json'), JSON.stringify(contents));
    expect(() => loadConfig(dir)).toThrow(expected);
  });

  it('reports unparseable JSON as such, not as a shape problem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-cli-config-'));
    writeFileSync(join(dir, 'metis.config.json'), '{ "ports": ');
    expect(() => loadConfig(dir)).toThrow(/not valid JSON/);
  });

  it('merges the auth block partially, the way ports and paths already do', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-cli-config-'));
    // An operator shortening the idle window should not have to restate the
    // other four keys to keep them.
    writeFileSync(join(dir, 'metis.config.json'), JSON.stringify({ auth: { sessionIdleHours: 1 } }));
    expect(loadConfig(dir).auth).toEqual({ ...DEFAULT_CONFIG.auth, sessionIdleHours: 1 });
  });

  it('names a bad auth key rather than silently taking the default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-cli-config-'));
    writeFileSync(join(dir, 'metis.config.json'), JSON.stringify({ auth: { loginAttempts: 0 } }));
    expect(() => loadConfig(dir)).toThrow(/auth\.loginAttempts/);
  });

  it('ships config defaults that are the code defaults, so neither can drift', () => {
    expect(DEFAULT_CONFIG.auth).toEqual({
      sessionAbsoluteHours: DEFAULT_SESSION_POLICY.absoluteHours,
      sessionIdleHours: DEFAULT_SESSION_POLICY.idleHours,
      maxSessions: DEFAULT_SESSION_POLICY.maxSessions,
      loginAttempts: DEFAULT_LOGIN_LIMIT.attempts,
      loginWindowMinutes: DEFAULT_LOGIN_LIMIT.windowMinutes,
    });
  });
});

/**
 * `.env` - the file that makes Windows bearable.
 *
 * Exactly one variable is genuinely required (METIS_ADMIN_SECRET), but the
 * README set it with `export`, which neither cmd.exe nor PowerShell has. A
 * project-local .env removes the shell from the question entirely.
 */
describe('the project .env', () => {
  const KEY = 'METIS_DOTENV_SPEC';
  afterEach(() => {
    delete process.env[KEY];
  });

  it('loads values from a .env beside the project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-dotenv-'));
    writeFileSync(join(dir, '.env'), `${KEY}=from_file\n`);
    expect(loadProjectEnv(dir)).toBe(true);
    expect(process.env[KEY]).toBe('from_file');
  });

  it('is optional: no file is not an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-dotenv-'));
    expect(loadProjectEnv(dir)).toBe(false);
    expect(process.env[KEY]).toBeUndefined();
  });

  it('lets a real environment variable win over the file', () => {
    // The shell is the more specific instruction: someone typing a value for one
    // command must not be silently overruled by a file they forgot they wrote.
    const dir = mkdtempSync(join(tmpdir(), 'metis-dotenv-'));
    writeFileSync(join(dir, '.env'), `${KEY}=from_file\n`);
    process.env[KEY] = 'from_shell';
    loadProjectEnv(dir);
    expect(process.env[KEY]).toBe('from_shell');
  });
});

/**
 * Bring your own Temporal. The runtime has always been able to attach to a
 * Temporal it did not start (MetisRuntime.externalTemporalAddress), but only
 * the compose entrypoint ever set it, so from the CLI the managed dev server
 * was the only option and every unsupported platform was a dead end.
 */
describe('an external Temporal address', () => {
  it('is nothing at all when neither the env nor the config asks for one', () => {
    expect(resolveTemporalAddress({}, DEFAULT_CONFIG)).toBeUndefined();
  });

  it('comes from metis.config.json', () => {
    expect(resolveTemporalAddress({}, { ...DEFAULT_CONFIG, temporalAddress: 'temporal.internal:7233' }))
      .toBe('temporal.internal:7233');
  });

  it('lets the environment win, so one command can override a committed file', () => {
    expect(
      resolveTemporalAddress(
        { METIS_TEMPORAL_ADDRESS: '127.0.0.1:7233' },
        { ...DEFAULT_CONFIG, temporalAddress: 'temporal.internal:7233' },
      ),
    ).toBe('127.0.0.1:7233');
  });

  it('treats an empty value as unset rather than as an address of ""', () => {
    // An unset variable in a shell script is an empty string, not an absent
    // key. Reading it as an address hands NativeConnection.connect "" and the
    // failure names Temporal rather than the config.
    expect(resolveTemporalAddress({ METIS_TEMPORAL_ADDRESS: '' }, DEFAULT_CONFIG)).toBeUndefined();
    expect(resolveTemporalAddress({ METIS_TEMPORAL_ADDRESS: '  ' }, DEFAULT_CONFIG)).toBeUndefined();
  });

  it('is carried on metis.config.json, partially merged like every other key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-cli-config-'));
    writeFileSync(
      join(dir, 'metis.config.json'),
      JSON.stringify({ temporalAddress: 'temporal.internal:7233' }),
    );
    const config = loadConfig(dir);
    expect(config.temporalAddress).toBe('temporal.internal:7233');
    expect(config.ports).toEqual(DEFAULT_CONFIG.ports);
  });

  it('is absent from the scaffolded default, which means "manage it for me"', () => {
    expect(DEFAULT_CONFIG.temporalAddress).toBeUndefined();
  });

  it('names the key when it is not a string', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-cli-config-'));
    writeFileSync(join(dir, 'metis.config.json'), JSON.stringify({ temporalAddress: 7233 }));
    expect(() => loadConfig(dir)).toThrow(/temporalAddress/);
  });
});

/**
 * `metis prune` - the deliberate clear. It deletes run history, so the default
 * is a dry run and an unset window is a refusal, not "delete everything".
 */
describe('metis prune', () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** A project directory with a config and some seeded runs in its store. */
  async function project(retentionDays?: number) {
    const dir = mkdtempSync(join(tmpdir(), 'metis-cli-prune-'));
    writeFileSync(
      join(dir, 'metis.config.json'),
      JSON.stringify({ ...DEFAULT_CONFIG, retentionDays }),
    );
    const gateway = new DataGateway(new SqliteAdapter(join(dir, '.metis', 'metis.db')));
    registerWorkflowTables(gateway);
    const store = new WorkflowStore(gateway);
    const seed = (executionId: string, ageDays: number, status: string) =>
      store.writeExecutionMeta({
        tenantId: 't1',
        executionId,
        workflowId: 'wf1',
        status,
        startTime: new Date(Date.now() - ageDays * DAY).toISOString(),
      });
    await seed('stale', 60, 'completed');
    await seed('parked', 60, 'running');
    return { dir, store };
  }

  it('refuses when no window is configured rather than guessing one', async () => {
    const { dir, store } = await project(undefined);
    const out = capture();
    const code = await runCli(['prune'], { cwd: dir, stdout: out.write, stderr: out.write });
    expect(code).toBe(1);
    expect(out.text()).toMatch(/retentionDays|--days/);
    expect(await store.getExecution('t1', 'stale')).toBeDefined();
  });

  it('is a dry run unless --yes is given', async () => {
    const { dir, store } = await project(30);
    const out = capture();
    const code = await runCli(['prune'], { cwd: dir, stdout: out.write, stderr: out.write });
    expect(code).toBe(0);
    expect(out.text()).toMatch(/--yes/);
    expect(await store.getExecution('t1', 'stale')).toBeDefined();
    expect(await store.getExecution('t1', 'parked')).toBeDefined();
  });

  it('--yes deletes the closed runs past the window and spares the live one', async () => {
    const { dir, store } = await project(30);
    const out = capture();
    const code = await runCli(['prune', '--yes'], { cwd: dir, stdout: out.write, stderr: out.write });
    expect(code).toBe(0);
    expect(await store.getExecution('t1', 'stale')).toBeUndefined();
    expect(await store.getExecution('t1', 'parked')).toBeDefined();
  });

  it('--days overrides the config so an operator can clear on demand', async () => {
    const { dir, store } = await project(undefined);
    const out = capture();
    const code = await runCli(['prune', '--days', '30', '--yes'], {
      cwd: dir,
      stdout: out.write,
      stderr: out.write,
    });
    expect(code).toBe(0);
    expect(await store.getExecution('t1', 'stale')).toBeUndefined();
  });

  it('refuses a --days that is not a whole number of days', async () => {
    const { dir, store } = await project(undefined);
    const out = capture();
    const code = await runCli(['prune', '--days', 'lots', '--yes'], {
      cwd: dir,
      stdout: out.write,
      stderr: out.write,
    });
    expect(code).toBe(1);
    expect(out.text()).toMatch(/--days/);
    expect(await store.getExecution('t1', 'stale')).toBeDefined();
  });
});
