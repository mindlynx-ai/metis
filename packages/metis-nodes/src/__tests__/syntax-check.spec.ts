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
 * Checking code without running it.
 *
 * Deliberately the REAL engines - V8 through isolated-vm, and CPython's own
 * `compile` - rather than a parser in the browser. An editor-side check knows
 * its own idea of the language, not this sandbox's: it would pass `fetch(...)`
 * and `require(...)`, neither of which exists here, and it has nothing at all to
 * say about Python. A check that is wrong about the runtime teaches the wrong
 * thing.
 *
 * Parses only. Nothing is executed, so validating is safe on code that would
 * delete your files if you ran it.
 */
import { describe, it, expect } from 'vitest';
import { checkSyntax } from '../syntax-check.js';
import { resolvePythonBinary } from '../python-runner.js';

describe('JavaScript', () => {
  it('accepts code that parses', async () => {
    expect(await checkSyntax('javascript', 'const a = 1;\nreturn a;')).toEqual({ ok: true });
  });

  it('accepts top-level return and await, which a plain parser would refuse', async () => {
    // The step body is a function body, not a module. A browser-side check
    // would call both of these syntax errors.
    expect(await checkSyntax('javascript', 'const v = await Promise.resolve(1);\nreturn v;')).toEqual({
      ok: true,
    });
  });

  it('reports the line the author wrote, not the wrapper line', async () => {
    const result = await checkSyntax('javascript', 'const a = 1;\nconst b = 2;\nreturn a b c;');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.line).toBe(3);
    expect(result.ok === false && result.message).toMatch(/Unexpected identifier/);
  });

  it('does not RUN what it checks', async () => {
    // If this executed, it would never return.
    const result = await checkSyntax('javascript', 'while (true) {}\nreturn 1;');
    expect(result).toEqual({ ok: true });
  }, 10_000);

  it('is unbothered by names that do not exist yet', async () => {
    // `input` is bound at run time. Syntax is the only question here.
    expect(await checkSyntax('javascript', 'return input.whatever.deep;')).toEqual({ ok: true });
  });
});

const pythonReady = resolvePythonBinary({ METIS_PYTHON: 'auto' }) !== undefined;

describe.skipIf(!pythonReady)('Python', () => {
  const withPython = async (code: string) => {
    const previous = process.env.METIS_PYTHON;
    process.env.METIS_PYTHON = 'auto';
    try {
      return await checkSyntax('python', code);
    } finally {
      if (previous === undefined) delete process.env.METIS_PYTHON;
      else process.env.METIS_PYTHON = previous;
    }
  };

  it('accepts code that parses', async () => {
    expect(await withPython('import json\nprint(json.dumps({"a": 1}))')).toEqual({ ok: true });
  });

  it('reports the line, with no preamble to subtract', async () => {
    // The user's source is compiled ALONE here - the preamble only binds
    // `input` at run time - so these line numbers need no adjusting at all.
    const result = await withPython('a = 1\nb = 2\nreturn a b c');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.line).toBe(3);
  });

  it('does not RUN what it checks', async () => {
    expect(await withPython('while True: pass')).toEqual({ ok: true });
  }, 15_000);

  it('is unbothered by names that do not exist yet', async () => {
    expect(await withPython('print(input["nope"])')).toEqual({ ok: true });
  });
});

describe('Python when it is switched off', () => {
  it('says why rather than reporting a syntax error', async () => {
    const previous = process.env.METIS_PYTHON;
    delete process.env.METIS_PYTHON;
    try {
      const result = await checkSyntax('python', 'print(1)');
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).toMatch(/METIS_PYTHON/);
    } finally {
      if (previous !== undefined) process.env.METIS_PYTHON = previous;
    }
  });
});

describe('an unknown language', () => {
  it('says so rather than guessing', async () => {
    const result = await checkSyntax('ruby', 'puts 1');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/ruby/);
  });
});
