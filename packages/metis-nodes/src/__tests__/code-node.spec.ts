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

/**
 * The `language` field. The catalogue offered javascript, typescript and python
 * and DEFAULTED to typescript - and the handler never read the field at all, so
 * it ran everything as raw JavaScript. Typed source got a V8 SyntaxError and
 * Python ran as JavaScript until it happened to throw. A tester reported it as
 * "the code node is not working", which was exactly right for anyone who
 * trusted the default.
 *
 * TypeScript has since gone entirely: Metis stripped types rather than checking
 * them, so it offered the syntax and none of the safety.
 */
describe('the language field', () => {
  const runIn = (language: string, code: string, input?: unknown) =>
    handler(nodeCtx('code', { code, input, language }));

  it('runs plain JavaScript when asked', async () => {
    const result = await runIn('javascript', 'return input.n * 2;', { n: 4 });
    expect(result.status).toBe(200);
    expect(nodeOutput(result)).toBe(8);
  });

  it('treats an absent language as JavaScript, matching the catalogue default', async () => {
    // The catalogue says default: "javascript". Anything else here would mean
    // the field's stated default and its real behaviour disagree again, which
    // is the bug this whole area started with.
    const result = await handler(nodeCtx('code', { code: 'return 7;', input: undefined }));
    expect(result.status).toBe(200);
    expect(nodeOutput(result)).toBe(7);
  });

  it('refuses TypeScript by name, rather than running it as JavaScript', async () => {
    // Nothing is live on it, so it is gone rather than quietly stripped. Running
    // typed source as JavaScript is what the original bug did, and it failed
    // confusingly instead of saying what was wrong.
    const result = await runIn('typescript', 'const n: number = 21;\nreturn n * 2;');
    expect(result.status).toBe(500);
    expect(result.message).toMatch(/typescript/);
    expect(result.message).toMatch(/javascript or python/);
  });

  it('refuses a language it cannot run, by name', async () => {
    const result = await runIn('ruby', 'puts 1');
    expect(result.status).toBe(500);
    expect(result.message).toMatch(/ruby/);
  });

  it('refuses python when no interpreter has been configured', async () => {
    // Python is unsandboxed, so it stays off until an operator says otherwise.
    // The refusal names the setting rather than failing obscurely.
    const previous = process.env.METIS_PYTHON;
    delete process.env.METIS_PYTHON;
    try {
      const result = await runIn('python', 'print(1)');
      expect(result.status).toBe(500);
      expect(result.message).toMatch(/METIS_PYTHON/);
    } finally {
      if (previous !== undefined) process.env.METIS_PYTHON = previous;
    }
  });
});

/**
 * The run input reaching `input`.
 *
 * The inspector's Test tab offers a "Sample input" box, sends the step alone
 * with that JSON as the run input, and shows what comes back. For a connector
 * step that works, because its config IS what it sends. For the code step the
 * box did nothing: `input` came from the node's own `inputData` config, which
 * on an untested step is empty, so testing `input.n` reported "Cannot read
 * properties of null". A box that changes nothing is worse than no box.
 *
 * The run input has always been on the handler context - switch and logic read
 * it for their predicates. The code step simply never looked.
 */
describe('the run input', () => {
  it('arrives as `input` when the step has no Data in of its own', async () => {
    const result = await handler(
      nodeCtx('code', { code: 'return input.n * 2;' }, { inputData: { n: 21 } }),
    );
    expect(result.status).toBe(200);
    expect(nodeOutput(result)).toBe(42);
  });

  it('lets a configured Data in win, because that is the wired-up answer', async () => {
    // In a real workflow `inputData` holds a {{...}} reference to an upstream
    // step. That is a deliberate choice and must beat the ambient run input.
    const result = await handler(
      nodeCtx('code', { code: 'return input.from;', inputData: { from: 'config' } },
        { inputData: { from: 'run' } }),
    );
    expect(nodeOutput(result)).toBe('config');
  });

  it('leaves `input` null when there is none anywhere, rather than throwing', async () => {
    // `null`, not undefined: the sandbox normalises an absent payload on the
    // way in. Asserted as a boolean so the envelope around a returned null is
    // not what is being pinned here.
    const result = await handler(nodeCtx('code', { code: 'return input === null;' }));
    expect(result.status).toBe(200);
    expect(nodeOutput(result)).toBe(true);
  });

  it('reaches Python too, so Test works the same way in either language', async () => {
    const ctx = nodeCtx(
      'code',
      { language: 'python', code: 'import json\nprint(json.dumps({"got": input["n"]}))' },
      { inputData: { n: 7 } },
    );
    const previous = process.env.METIS_PYTHON;
    process.env.METIS_PYTHON = 'auto';
    try {
      const result = await handler(ctx);
      // Skip cleanly where no interpreter exists rather than failing the suite.
      if (result.status === 500 && /not enabled|METIS_PYTHON/.test(String(result.message))) return;
      expect(result.status).toBe(200);
      expect(nodeOutput(result)).toEqual({ got: 7 });
    } finally {
      if (previous === undefined) delete process.env.METIS_PYTHON;
      else process.env.METIS_PYTHON = previous;
    }
  });
});
