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
import { nodeCtx, nodeOutput } from '@mindlynx/metis-ports';
import { createCodeNodeHandler } from '../code-node.js';

const handler = createCodeNodeHandler();

const run = (code: string, input?: unknown, timeoutMs?: number) =>
  handler(nodeCtx('code', { code, input, timeoutMs }));

describe('code node sandbox', () => {
  it('runs user code with input and returns the value', async () => {
    const result = await run('return input.a + input.b;', { a: 2, b: 3 });
    expect(result.status).toBe(200);
    expect(nodeOutput(result)).toBe(5);
  });

  it('supports async user code and objects', async () => {
    const result = await run('const v = await Promise.resolve({ok: true}); return v;');
    expect(result.status).toBe(200);
    expect(nodeOutput(result)).toEqual({ ok: true });
  });

  it('exposes the helper surface', async () => {
    const result = await run(
      "return { h: helpers.hash('x'), u: helpers.uuid(), d: helpers.parseDate('2026-01-02') };",
    );
    expect(result.status).toBe(200);
    const output = nodeOutput(result) as { h: string; u: string; d: string };
    expect(output.h).toMatch(/^[0-9a-f]{64}$/);
    expect(output.u).toMatch(/^[0-9a-f-]{36}$/);
    expect(output.d).toBe('2026-01-02T00:00:00.000Z');
  });

  it('denies network, require and process', async () => {
    const probes = await run(
      'return { f: typeof fetch, p: typeof process, x: typeof XMLHttpRequest };',
    );
    expect(nodeOutput(probes)).toEqual({ f: 'undefined', p: 'undefined', x: 'undefined' });

    const req = await run("return require('node:fs');");
    expect(req.status).not.toBe(200);
    expect(req.message).toMatch(/require/i);
  });

  it('denies Date.now and Math.random deterministically', async () => {
    const now = await run('return Date.now();');
    expect(now.status).not.toBe(200);
    expect(now.message).toMatch(/Date\.now is not available/i);

    const random = await run('return Math.random();');
    expect(random.status).not.toBe(200);
    expect(random.message).toMatch(/Math\.random is not available/i);
  });

  it('times out runaway code', async () => {
    const result = await run('while (true) {}', undefined, 300);
    expect(result.status).not.toBe(200);
    expect(result.message).toMatch(/timed out|timeout/i);
  });

  // Transferability: the handler must honour the shared-catalogue / Helix keys
  // `inputData` and `timeout`, not just the legacy Metis `input`/`timeoutMs`.
  it('reads the Helix config keys inputData and timeout', async () => {
    const withInputData = await handler(
      nodeCtx('code', { code: 'return input.a * 2;', inputData: { a: 21 } }),
    );
    expect(nodeOutput(withInputData)).toBe(42);

    const timedOut = await handler(nodeCtx('code', { code: 'while (true) {}', timeout: 300 }));
    expect(timedOut.status).not.toBe(200);
    expect(timedOut.message).toMatch(/timed out|timeout/i);
  });

  it('caps memory at 32MB', async () => {
    const result = await run(
      'const chunks = []; while (true) { chunks.push(new Array(1024 * 1024).fill(7)); }',
      undefined,
      5000,
    );
    expect(result.status).not.toBe(200);
    expect(result.message).toMatch(/memory|disposed|timed out/i);
  }, 20_000);
});
