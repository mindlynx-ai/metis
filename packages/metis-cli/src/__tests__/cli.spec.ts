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
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, loadConfig, HELP_TEXT } from '../cli.js';
import { DEFAULT_CONFIG } from '../scaffold.js';

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
    for (const command of ['init', 'up', 'run', 'connectors seed', 'triggers add', 'webhooks add']) {
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

    const config = JSON.parse(readFileSync(join(dir, 'metis.config.json'), 'utf8')) as {
      datastore: string;
      ports: { editor: number; temporalGrpc: number; temporalUi: number };
    };
    expect(config.datastore).toBe('sqlite');
    expect(config.ports).toEqual({ editor: 3000, temporalGrpc: 7233, temporalUi: 8233 });

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
});
