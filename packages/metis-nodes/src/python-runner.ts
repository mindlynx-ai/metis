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
 * The Python arm of the code node: the interpreter on this machine.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE. The JavaScript arm runs in an
 * isolated-vm isolate with no disk, no network and no require - a guarantee
 * SECURITY.md makes in as many words. Python has none of that. It is CPython
 * with the full standard library, running as whoever runs Metis. Anyone who can
 * author a workflow can therefore read that user's files and reach the network.
 *
 * That is a deliberate product decision, and the containment for it is that the
 * arm does not exist until an operator sets METIS_PYTHON. An unsandboxed
 * execution primitive must never arrive by upgrade without being asked for.
 *
 * The mechanics that keep the rest honest:
 *   - source goes in on STDIN, never on the command line. `-c` hits argument
 *     length limits and drags in a quoting problem that differs between cmd.exe
 *     and PowerShell, which is where injection lives on Windows.
 *   - shell: false, always. No shell means no metacharacters to get wrong.
 *   - the node's own timeout is enforced here with SIGTERM then SIGKILL,
 *     because a spawned process ignores the isolate's budget.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** How to invoke an interpreter: a binary plus any leading arguments. */
export interface PythonBinary {
  command: string;
  args: string[];
}

export type PythonResult =
  | { status: 'ok'; value: unknown }
  | { status: 'error' | 'timeout'; error: string };

/** Cap on what a script may print back, so a runaway loop cannot eat memory. */
const MAX_OUTPUT_BYTES = 1_000_000;
/** Grace between asking a process to stop and making it. */
const KILL_GRACE_MS = 2_000;

/**
 * The interpreters worth trying, best first, for a platform.
 *
 * `py -3` leads on Windows because plain `python` there is usually the Microsoft
 * Store alias stub: it exits without running anything, which reads as a broken
 * Metis rather than an absent Python.
 */
export function pythonCandidates(platform: NodeJS.Platform = process.platform): PythonBinary[] {
  if (platform === 'win32') {
    return [
      { command: 'py', args: ['-3'] },
      { command: 'python3', args: [] },
      { command: 'python', args: [] },
    ];
  }
  return [
    { command: 'python3', args: [] },
    { command: 'python', args: [] },
  ];
}

/** Does this interpreter exist and run? One cheap synchronous probe. */
function works(candidate: PythonBinary): boolean {
  try {
    // A version check is the cheapest thing that proves the binary resolves AND
    // executes, which is what separates a real install from the Windows Store
    // alias stub (it resolves, then exits without running anything).
    const probe = spawnSync(candidate.command, [...candidate.args, '--version'], {
      shell: false,
      timeout: 5_000,
      stdio: 'ignore',
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

/**
 * Which interpreter to use, or undefined when Python is switched off.
 *
 * `METIS_PYTHON` unset or blank => off, and the code node refuses the language.
 * `auto` => search the platform's candidates.
 * anything else => that path, verbatim and unprobed, because an operator naming
 * a specific interpreter means it.
 */
export function resolvePythonBinary(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): PythonBinary | undefined {
  const setting = env.METIS_PYTHON?.trim();
  if (!setting) return undefined;
  if (setting !== 'auto') return { command: setting, args: [] };
  return pythonCandidates(platform).find(works);
}

/**
 * Run a script and read its last line of stdout as JSON.
 *
 * @param binary - from {@link resolvePythonBinary}.
 * @param source - the user's Python.
 * @param input - the node's resolved input, bound to `input` in the script.
 * @param timeoutMs - the node's timeout.
 */
export function runPython(
  binary: PythonBinary,
  source: string,
  input: unknown,
  timeoutMs: number,
): Promise<PythonResult> {
  // The source goes in a FILE and the input goes on STDIN, because they cannot
  // share a channel: `python -` reads the whole of stdin as the program, so a
  // preamble reading stdin for its data found the stream already consumed and
  // every input came through as null.
  //
  // A file also keeps the source off the command line, which is the part that
  // matters on Windows - `-c` there means argument-length limits and a quoting
  // problem that differs between cmd.exe and PowerShell.
  const preamble = 'import json,sys\ninput = json.loads(sys.stdin.readline() or "null")\n';
  const dir = mkdtempSync(join(tmpdir(), 'metis-py-'));
  const scriptPath = join(dir, 'step.py');
  writeFileSync(scriptPath, preamble + source, { mode: 0o600 });

  return new Promise<PythonResult>((resolve) => {
    const child = spawn(binary.command, [...binary.args, scriptPath], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (result: PythonResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      // The script can hold secrets the author typed. Remove it on every path,
      // including the timeout one, rather than leaving it in the temp dir.
      rmSync(dir, { recursive: true, force: true });
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ status: 'timeout', error: `python did not finish within ${timeoutMs}ms` });
    }, timeoutMs);
    // SIGTERM is a request. A tight loop can ignore it, and on Windows Node
    // translates both to TerminateProcess anyway, so the second one is the
    // guarantee the first is not.
    const hardTimer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + KILL_GRACE_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      out = (out + chunk.toString()).slice(-MAX_OUTPUT_BYTES);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString()).slice(-MAX_OUTPUT_BYTES);
    });
    child.on('error', (error) => finish({ status: 'error', error: error.message }));
    child.on('close', (code) => {
      if (code !== 0) {
        finish({ status: 'error', error: err.trim() || `python exited with code ${code}` });
        return;
      }
      // The LAST non-empty line, so a script that logs progress before its
      // result is not punished for it.
      const last = out.trim().split('\n').filter(Boolean).at(-1) ?? '';
      try {
        finish({ status: 'ok', value: JSON.parse(last) });
      } catch {
        finish({
          status: 'error',
          error:
            'the script finished but its last line of output was not JSON. Print a '
            + 'JSON value as the last thing your script does, for example '
            + '`print(json.dumps(result))`.',
        });
      }
    });

    // One line of JSON: the preamble reads exactly one line, so the payload can
    // hold anything as long as it does not carry a raw newline - and JSON.stringify
    // escapes those.
    child.stdin.write(`${JSON.stringify(input ?? null)}\n`);
    child.stdin.end();
  });
}
