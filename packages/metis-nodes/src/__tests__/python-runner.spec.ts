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
 * The Python arm of the code node.
 *
 * Unlike JavaScript, this is NOT a sandbox: it is the interpreter on the
 * machine, with that machine's disk and network. That is a deliberate choice
 * and the reason the whole arm is off until an operator names an interpreter.
 */
import { describe, it, expect } from 'vitest';
import { pythonCandidates, resolvePythonBinary, runPython } from '../python-runner.js';

describe('choosing an interpreter', () => {
  it('tries the Windows launcher first on win32', () => {
    // `python` on Windows is usually the Store alias stub, which exits without
    // running anything. `py -3` is the launcher that actually resolves a real
    // install, so it has to be asked first.
    const [first] = pythonCandidates('win32');
    expect(first).toEqual({ command: 'py', args: ['-3'] });
    expect(pythonCandidates('win32').map((c) => c.command)).toEqual(['py', 'python3', 'python']);
  });

  it('does not reach for the launcher anywhere else', () => {
    expect(pythonCandidates('linux').map((c) => c.command)).toEqual(['python3', 'python']);
    expect(pythonCandidates('darwin').map((c) => c.command)).toEqual(['python3', 'python']);
  });

  it('is off unless an operator names one', () => {
    // No METIS_PYTHON means the language is refused. An unsandboxed execution
    // primitive must never arrive by upgrade without being asked for.
    expect(resolvePythonBinary({})).toBeUndefined();
    expect(resolvePythonBinary({ METIS_PYTHON: '' })).toBeUndefined();
    expect(resolvePythonBinary({ METIS_PYTHON: '   ' })).toBeUndefined();
  });

  it('takes an explicit path verbatim', () => {
    expect(resolvePythonBinary({ METIS_PYTHON: '/usr/local/bin/python3.12' })).toEqual({
      command: '/usr/local/bin/python3.12',
      args: [],
    });
  });

  it('searches when asked to', () => {
    const found = resolvePythonBinary({ METIS_PYTHON: 'auto' }, 'linux');
    expect(found?.command).toBe('python3');
  });
});

// The spawn tests need a real interpreter. Gated the way the repo already gates
// its real-Temporal specs, so a machine without Python does not go red.
const hasPython = resolvePythonBinary({ METIS_PYTHON: 'auto' }) !== undefined;

describe.skipIf(!hasPython)('running Python', () => {
  const bin = resolvePythonBinary({ METIS_PYTHON: 'auto' })!;

  it('returns whatever the script prints as JSON', async () => {
    const result = await runPython(bin, 'print(__import__("json").dumps({"hi": 1 + 1}))', {}, 10_000);
    expect(result).toEqual({ status: 'ok', value: { hi: 2 } });
  });

  it('hands the node input in as `input`', async () => {
    const source = 'import json; print(json.dumps({"doubled": input["n"] * 2}))';
    const result = await runPython(bin, source, { n: 21 }, 10_000);
    expect(result).toEqual({ status: 'ok', value: { doubled: 42 } });
  });

  it('reports a syntax error as an error, with the interpreter message', async () => {
    // Genuinely unparseable. `this is not python` looks broken but is a valid
    // expression (`this is (not python)`), so it raises NameError instead - a
    // decent reminder that the interpreter, not the test author, decides.
    const result = await runPython(bin, 'def (:', {}, 10_000);
    expect(result.status).toBe('error');
    expect(result.status === 'ok' ? '' : result.error).toMatch(/SyntaxError/);
  });

  it("passes the interpreter's own runtime error through", async () => {
    const result = await runPython(bin, 'raise ValueError("no good")', {}, 10_000);
    expect(result.status).toBe('error');
    expect(result.status === 'ok' ? '' : result.error).toMatch(/ValueError: no good/);
  });

  it('kills a runaway script at the timeout', async () => {
    const result = await runPython(bin, 'while True: pass', {}, 1_000);
    expect(result.status).toBe('timeout');
  }, 15_000);

  it('says so plainly when the script prints nothing usable', async () => {
    const result = await runPython(bin, 'print("not json")', {}, 10_000);
    expect(result.status).toBe('error');
    expect(result.status === 'ok' ? '' : result.error).toMatch(/JSON/i);
  });
});
