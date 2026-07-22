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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFlags, buildTriggerInput, formatTriggerList } from '../triggers.js';
import { runCli } from '../cli.js';

function capture() {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), text: () => lines.join('\n') };
}

describe('trigger argument parsing', () => {
  it('splits positionals from flags, treating a bare flag as true', () => {
    const { positional, flags } = parseFlags(['webhook', 'wf', '--connector', 'github', '--dry']);
    expect(positional).toEqual(['webhook', 'wf']);
    expect(flags).toEqual({ connector: 'github', dry: 'true' });
  });

  it('builds a webhook input, defaulting github verification', () => {
    const input = buildTriggerInput('webhook', 'wf', { connector: 'github', secret: 's' });
    expect(input).toMatchObject({ kind: 'webhook', verification: 'github', secret: 's' });
  });

  it('requires a secret unless verification is none', () => {
    expect(() => buildTriggerInput('webhook', 'wf', { connector: 'github' })).toThrow(/secret/);
    expect(buildTriggerInput('webhook', 'wf', { verification: 'none' }).kind).toBe('webhook');
  });

  it('requires connector, operation and cursor for a poll', () => {
    expect(() => buildTriggerInput('poll', 'wf', { connector: 'hubspot' })).toThrow(/operation/);
    const ok = buildTriggerInput('poll', 'wf', { connector: 'hubspot', operation: 'listContacts', cursor: 'createdAt' });
    expect(ok).toMatchObject({ kind: 'poll', operation: 'listContacts', cursorField: 'createdAt' });
  });

  it('requires a cron for a schedule and rejects unknown kinds', () => {
    expect(() => buildTriggerInput('schedule', 'wf', {})).toThrow(/cron/);
    expect(() => buildTriggerInput('wibble', 'wf', {})).toThrow(/unknown trigger kind/);
  });

  it('renders a list with kind and target columns', () => {
    const text = formatTriggerList([
      { triggerId: 'trg_1', tenantId: 't1', kind: 'webhook', workflowId: 'wf', enabled: true, connectorId: 'github', event: 'push' },
      { triggerId: 'trg_2', tenantId: 't1', kind: 'schedule', workflowId: 'wf2', enabled: true, cron: '0 * * * *' },
    ]);
    expect(text).toContain('KIND');
    expect(text).toMatch(/trg_1 .*webhook .*github:push/);
    expect(text).toMatch(/trg_2 .*schedule .*0 \* \* \* \*/);
  });
});

describe('metis triggers CLI', () => {
  it('adds a webhook, lists it, and removes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-triggers-'));
    await runCli(['init'], { cwd: dir, stdout: () => undefined, stderr: () => undefined });

    const add = capture();
    const addCode = await runCli(
      ['triggers', 'add', 'webhook', 'hello', '--connector', 'github', '--event', 'push', '--secret', 'sec'],
      { cwd: dir, stdout: add.write, stderr: add.write },
    );
    expect(addCode).toBe(0);
    expect(add.text()).toMatch(/Created webhook trigger trg_/);
    expect(add.text()).toMatch(/POST it at \/hooks\/trg_/);
    const triggerId = /\/hooks\/(trg_[\w-]+)/.exec(add.text())?.[1] as string;

    const list = capture();
    await runCli(['triggers', 'list'], { cwd: dir, stdout: list.write, stderr: list.write });
    expect(list.text()).toContain(triggerId);
    expect(list.text()).toContain('github:push');

    const remove = capture();
    const removeCode = await runCli(['triggers', 'remove', triggerId], { cwd: dir, stdout: remove.write, stderr: remove.write });
    expect(removeCode).toBe(0);
    expect(remove.text()).toMatch(/Removed trg_/);

    const empty = capture();
    await runCli(['triggers', 'list'], { cwd: dir, stdout: empty.write, stderr: empty.write });
    expect(empty.text()).toMatch(/No triggers yet/);
  });

  it('adds a schedule trigger and reports deferred provisioning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-triggers-'));
    await runCli(['init'], { cwd: dir, stdout: () => undefined, stderr: () => undefined });
    const out = capture();
    const code = await runCli(
      ['triggers', 'add', 'schedule', 'hello', '--cron', '0 9 * * *'],
      { cwd: dir, stdout: out.write, stderr: out.write },
    );
    expect(code).toBe(0);
    expect(out.text()).toMatch(/Created schedule trigger/);
    expect(out.text()).toMatch(/provisioned in Temporal/);
  });

  it('rejects an invalid add and an unknown subcommand', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-triggers-'));
    await runCli(['init'], { cwd: dir, stdout: () => undefined, stderr: () => undefined });
    const bad = capture();
    const badCode = await runCli(['triggers', 'add', 'poll', 'hello'], { cwd: dir, stdout: bad.write, stderr: bad.write });
    expect(badCode).toBe(1);
    expect(bad.text()).toMatch(/poll triggers need/);

    const unknown = capture();
    const unknownCode = await runCli(['triggers', 'wibble'], { cwd: dir, stdout: unknown.write, stderr: unknown.write });
    expect(unknownCode).toBe(1);
    expect(unknown.text()).toMatch(/usage: metis triggers/);
  });
});
