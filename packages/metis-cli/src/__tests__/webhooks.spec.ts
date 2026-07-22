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
import { expandEvents, buildWebhookInput, formatWebhookList } from '../webhooks.js';
import { runCli } from '../cli.js';

function capture() {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), text: () => lines.join('\n') };
}

describe('outbound webhook argument parsing', () => {
  it('expands event aliases and the wildcard', () => {
    expect(expandEvents('completed,failed')).toEqual([
      'workflow.execution.completed',
      'workflow.execution.failed',
    ]);
    expect(expandEvents('all')).toEqual(['*']);
    expect(expandEvents(undefined)).toEqual(['*']);
    expect(expandEvents('workflow.node.started')).toEqual(['workflow.node.started']);
  });

  it('validates the url scheme', () => {
    expect(() => buildWebhookInput(undefined, {})).toThrow(/URL is required/);
    expect(() => buildWebhookInput('ftp://x', {})).toThrow(/http or https/);
    const input = buildWebhookInput('https://hook.test/in', { events: 'completed', secret: 's' });
    expect(input).toMatchObject({ url: 'https://hook.test/in', secret: 's', events: ['workflow.execution.completed'] });
  });

  it('renders a list with signed and events columns', () => {
    const text = formatWebhookList([
      { webhookId: 'owh_1', tenantId: 't1', url: 'https://a.test', events: ['*'], enabled: true, secret: 'k' },
    ]);
    expect(text).toContain('EVENTS');
    expect(text).toMatch(/owh_1 .*signed .*\* .*https:\/\/a\.test/);
  });
});

describe('metis webhooks CLI', () => {
  it('registers, lists and removes an outbound webhook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-webhooks-'));
    await runCli(['init'], { cwd: dir, stdout: () => undefined, stderr: () => undefined });

    const add = capture();
    const addCode = await runCli(
      ['webhooks', 'add', 'https://hook.test/in', '--events', 'completed,failed', '--secret', 'sh'],
      { cwd: dir, stdout: add.write, stderr: add.write },
    );
    expect(addCode).toBe(0);
    expect(add.text()).toMatch(/Registered outbound webhook owh_/);
    expect(add.text()).toMatch(/signed/);
    const webhookId = /(owh_[\w-]+)/.exec(add.text())?.[1] as string;

    const list = capture();
    await runCli(['webhooks', 'list'], { cwd: dir, stdout: list.write, stderr: list.write });
    expect(list.text()).toContain(webhookId);
    expect(list.text()).toContain('https://hook.test/in');

    const remove = capture();
    const removeCode = await runCli(['webhooks', 'remove', webhookId], { cwd: dir, stdout: remove.write, stderr: remove.write });
    expect(removeCode).toBe(0);
    expect(remove.text()).toMatch(/Removed owh_/);
  });

  it('rejects a bad url and an unknown subcommand', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-webhooks-'));
    await runCli(['init'], { cwd: dir, stdout: () => undefined, stderr: () => undefined });
    const bad = capture();
    const badCode = await runCli(['webhooks', 'add', 'ftp://nope'], { cwd: dir, stdout: bad.write, stderr: bad.write });
    expect(badCode).toBe(1);
    expect(bad.text()).toMatch(/http or https/);

    const unknown = capture();
    const unknownCode = await runCli(['webhooks', 'wibble'], { cwd: dir, stdout: unknown.write, stderr: unknown.write });
    expect(unknownCode).toBe(1);
    expect(unknown.text()).toMatch(/usage: metis webhooks/);
  });
});
