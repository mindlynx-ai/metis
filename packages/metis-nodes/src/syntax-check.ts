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
 * Does this code parse? Asked of the engine that will actually run it.
 *
 * The alternative was checking in the browser, and it would have been wrong in
 * both directions. A JavaScript checker built for the web passes `fetch(...)`
 * and `require(...)`, neither of which exists in this sandbox, and refuses
 * top-level `return` and `await`, both of which are how every step here is
 * written. For Python it has nothing to say at all. A check that disagrees with
 * the runtime teaches people to distrust the runtime.
 *
 * Nothing is executed. V8 compiles the script and throws it away; CPython's
 * `compile` builds a code object nobody calls. So validating an infinite loop
 * returns immediately, and validating code that would wipe a disk does nothing
 * to the disk.
 */
import { spawn } from 'node:child_process';
import { JS_PRELUDE, retargetJsPositions } from './error-positions.js';
import { loadIvm } from './code-node.js';
import { resolvePythonBinary } from './python-runner.js';

export type SyntaxResult =
  | { ok: true }
  | { ok: false; message: string; line?: number; column?: number };

/** `line 3, column 10` out of an already-retargeted message. */
const POSITION = /line (\d+), column (\d+)/;

/** How long CPython gets to parse before we stop waiting. */
const PARSE_TIMEOUT_MS = 10_000;

/**
 * @param language - `javascript` or `python`.
 * @param code - the step body, exactly as the author typed it.
 */
export async function checkSyntax(language: string, code: string): Promise<SyntaxResult> {
  if (language === 'javascript') return checkJavaScript(code);
  if (language === 'python') return checkPython(code);
  return { ok: false, message: `Metis cannot check "${language}" - choose javascript or python.` };
}

function checkJavaScript(code: string): SyntaxResult {
  // Wrapped exactly as the runner wraps it, so top-level return and await are
  // legal here for the same reason they are legal at run time - and so the
  // reported line is the author's, via the same retargeting.
  const wrapped = [...JS_PRELUDE, code, '})();', '})()'].join('\n');
  const isolate = new (loadIvm()).Isolate({ memoryLimit: 16 });
  try {
    isolate.compileScriptSync(wrapped);
    return { ok: true };
  } catch (error) {
    const message = retargetJsPositions(error instanceof Error ? error.message : String(error));
    const at = POSITION.exec(message);
    return at
      ? { ok: false, message, line: Number(at[1]), column: Number(at[2]) }
      : { ok: false, message };
  } finally {
    isolate.dispose();
  }
}

/**
 * CPython parses its own source. The user's code is compiled ALONE, with no
 * preamble, so its line numbers need no adjusting - the preamble only exists to
 * bind `input` at run time and a parser does not care that `input` is undefined.
 */
function checkPython(code: string): Promise<SyntaxResult> {
  const binary = resolvePythonBinary(process.env);
  if (!binary) {
    return Promise.resolve({
      ok: false,
      message:
        'Python is not enabled on this Metis, so it cannot be checked. Set METIS_PYTHON to an '
        + 'interpreter path, or to "auto" to find one.',
    });
  }
  const program = [
    'import sys, json',
    'src = sys.stdin.read()',
    'try:',
    '    compile(src, "your code", "exec")',
    '    print(json.dumps({"ok": True}))',
    'except SyntaxError as e:',
    '    print(json.dumps({"ok": False, "message": e.msg, "line": e.lineno, "column": e.offset}))',
  ].join('\n');

  return new Promise<SyntaxResult>((resolve) => {
    const child = spawn(binary.command, [...binary.args, '-c', program], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const finish = (result: SyntaxResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, message: 'checking took too long' });
    }, PARSE_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on('error', (error) => finish({ ok: false, message: error.message }));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) ?? '') as
          | { ok: true }
          | { ok: false; message: string; line?: number; column?: number };
        finish(parsed);
      } catch {
        finish({ ok: false, message: 'could not read the checker output' });
      }
    });
    // The source on stdin, never on the command line: no quoting, no length
    // limit, and nothing for a shell to interpret - there is no shell.
    child.stdin.write(code);
    child.stdin.end();
  });
}
