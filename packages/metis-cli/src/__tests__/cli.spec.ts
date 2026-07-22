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
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, HELP_TEXT } from '../cli.js';

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
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'metis.config.json'), before);

    const out = capture();
    const code = await runCli(['init'], { cwd: dir, stdout: out.write, stderr: out.write });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'metis.config.json'), 'utf8')).toContain('"postgres"');
    expect(out.text()).toMatch(/already initialised|already exists/i);
  });
});
