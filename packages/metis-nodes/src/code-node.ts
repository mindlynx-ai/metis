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
 * The code node: user JavaScript in a fresh isolated-vm
 * isolate per invocation, ported from the origin transformCode.ts
 * sandbox with two additional denials the Metis spec demands:
 * Date.now and Math.random throw inside the sandbox. The isolate has
 * no require, no fetch, no process; 32MB heap; 5s default budget.
 * Helpers (hash, uuid, parseDate, formatDate) are host-side closures
 * exposed through references, so the sandbox cannot reach back.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { JS_PRELUDE, retargetJsPositions } from './error-positions.js';
import { resolvePythonBinary, runPython } from './python-runner.js';
import type ivmType from 'isolated-vm';
import { stateEnvelope, type NodeHandler } from '@mindlynx/metis-ports';

// isolated-vm is a native module; createRequire keeps bundlers away.
const requireModule = createRequire(import.meta.url);

/**
 * The isolate library, loaded on FIRST USE rather than at import.
 *
 * It used to be a bare module-scope require. metis-nodes re-exports this file
 * and the CLI imports the package, so an install where the native binding did
 * not build took down `metis up` at boot with a raw MODULE_NOT_FOUND pointing
 * into node-gyp - nothing naming the code node, and nothing to suggest the rest
 * of the product was fine. This is the same shape as loadSqlServer() next door.
 */
let ivmModule: typeof ivmType | undefined;
function loadIvm(): typeof ivmType {
  if (ivmModule) return ivmModule;
  try {
    ivmModule = requireModule('isolated-vm') as typeof ivmType;
    return ivmModule;
  } catch (error) {
    throw new Error(
      'the code step needs isolated-vm, and it is not usable in this install: '
        + `${error instanceof Error ? error.message : String(error)}. It ships prebuilt `
        + 'for Node 22 and 24 on macOS (Apple Silicon), Linux and Windows x64; anything '
        + 'else builds from source and needs Python and a C++ toolchain. Every other '
        + 'step type works without it.',
    );
  }
}

export const SANDBOX_MEMORY_MB = 32;
export const SANDBOX_DEFAULT_TIMEOUT_MS = 5_000;
export const SANDBOX_MAX_TIMEOUT_MS = 30_000;

const DENIALS = `
  Date.now = () => { throw new Error('Date.now is not available in the code sandbox'); };
  Math.random = () => { throw new Error('Math.random is not available in the code sandbox'); };
`;

async function injectHelpers(context: ivmType.Context): Promise<void> {
  await context.global.set(
    '__metis_hash',
    new (loadIvm()).Reference((input: string, algo?: string): string => {
      const algorithm = algo === 'md5' ? 'md5' : 'sha256';
      return createHash(algorithm).update(String(input)).digest('hex');
    }),
  );
  await context.global.set('__metis_uuid', new (loadIvm()).Reference((): string => randomUUID()));
  await context.global.set(
    '__metis_parseDate',
    new (loadIvm()).Reference((input: string): string => {
      const parsed = new Date(input);
      if (Number.isNaN(parsed.getTime())) throw new Error(`parseDate: cannot parse '${input}'`);
      return parsed.toISOString();
    }),
  );
  await context.global.set(
    '__metis_formatDate',
    new (loadIvm()).Reference((input: string, locale?: string): string => {
      const parsed = new Date(input);
      if (Number.isNaN(parsed.getTime())) throw new Error(`formatDate: cannot parse '${input}'`);
      return parsed.toLocaleString(locale ?? 'en-GB');
    }),
  );
  await context.eval(
    `
    globalThis.helpers = Object.freeze({
      hash: (input, algo) => __metis_hash.applySync(undefined, [String(input ?? ''), algo ?? 'sha256']),
      uuid: () => __metis_uuid.applySync(undefined, []),
      parseDate: (input) => __metis_parseDate.applySync(undefined, [String(input ?? '')]),
      formatDate: (input, locale) => __metis_formatDate.applySync(undefined, [String(input ?? ''), locale ?? 'en-GB']),
    });
    `,
    { timeout: 100 },
  );
}

export interface RunUserCodeResult {
  status: 'ok' | 'timeout' | 'oom' | 'error';
  value?: unknown;
  error?: string;
}

/** Execute user JS in a fresh isolate; always disposes it afterwards. */
export async function runUserCode(
  code: string,
  input: unknown,
  timeoutMs: number,
): Promise<RunUserCodeResult> {
  const isolate = new (loadIvm()).Isolate({ memoryLimit: SANDBOX_MEMORY_MB });
  try {
    const context = await isolate.createContext();
    await context.eval(DENIALS, { timeout: 100 });
    await injectHelpers(context);
    await context.eval(`const input = ${JSON.stringify(input ?? null)};`, { timeout: 100 });

    // Built line by line, and the user's source starts at COLUMN 0 of its own
    // line. It used to be spliced into the middle of line 3, so a mistake on
    // line 1 column 5 was reported as [<isolated-vm>:3:51] - two lines and
    // forty-five columns out. Now the only difference is JS_PRELUDE_LINES, one
    // constant that retargetJsPositions subtracts back off.
    //
    // The prelude comes from error-positions.ts, which also derives the count
    // that subtracts it - so the wrapper cannot grow a line without the
    // translation following it.
    const wrapped = [
      ...JS_PRELUDE,
      code,
      '})();',
      "return __value === undefined ? '__metis_undefined__' : JSON.stringify(__value);",
      '})()',
    ].join('\n');
    const resultJson = (await context.eval(wrapped, {
      timeout: timeoutMs,
      promise: true,
    })) as string;
    return {
      status: 'ok',
      value: resultJson === '__metis_undefined__' ? undefined : JSON.parse(resultJson),
    };
  } catch (error) {
    // Retargeted before it leaves: every position in here counts lines in the
    // wrapper, and the person reading counts lines in their own file.
    const message = retargetJsPositions(error instanceof Error ? error.message : String(error));
    if (/timed out/i.test(message)) return { status: 'timeout', error: message };
    if (/disposed|memory/i.test(message)) return { status: 'oom', error: message };
    return { status: 'error', error: message };
  } finally {
    // An out-of-memory kill disposes the isolate automatically.
    if (!isolate.isDisposed) isolate.dispose();
  }
}

// Config keys mirror the shared catalogue and the Helix code handler so a
// code node authored in either engine runs unchanged. `timeoutMs` and `input`
// are the legacy Metis aliases, kept for back-compat.
interface CodeNodeConfig {
  code?: string;
  script?: string; // catalogue alias for `code`
  inputData?: unknown; // the resolved input payload (Helix key)
  input?: unknown; // legacy Metis alias for inputData
  timeout?: number; // primary timeout in ms (catalogue + Helix)
  timeoutMs?: number; // legacy alias
  language?: string; // javascript | typescript | python (catalogue default: typescript)
}

/**
 * What the catalogue offers, and what the default is when nobody chose.
 *
 * JavaScript. TypeScript was the default and is no longer offered: Metis only
 * ever STRIPPED the types rather than checking them, so it gave authors the
 * syntax and none of the safety while implying otherwise.
 *
 * The stripping path below stays for steps already saved as `typescript`. They
 * keep running exactly as before; the language simply cannot be chosen again.
 */
const DEFAULT_LANGUAGE = 'javascript';

/**
 * Strip the types off TypeScript so the isolate can run it.
 *
 * Node's own stripper: types-only syntax erased, nothing transpiled, no
 * dependency. That is the honest limit and it is documented on the node - a
 * `const enum`, a decorator or anything else that needs real code generation is
 * not supported, and says so rather than failing strangely.
 */
function stripTypes(source: string): string {
  // The user writes a function BODY, not a module: `return x;` at the top level
  // is what every code step looks like. Handing that to a parser is a syntax
  // error before it ever reaches a type, so wrap it, strip, and cut the wrapper
  // back off.
  //
  // Slicing by length is safe BECAUSE the stripper blanks types in place rather
  // than removing them - `const x: number` becomes `const x         ` - so every
  // offset after the wrapper is exactly where it started. A test pins that.
  const prefix = 'async function __metis_wrap() {\n';
  const suffix = '\n}';
  // The API is flagged experimental, so Node prints a warning the first time it
  // is called. That warning is about Node, not about the user's workflow, and
  // seeing it in a run log reads as "your step is broken". Silence only this
  // one, only for the duration of the call.
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (text.includes('stripTypeScriptTypes')) return;
    (emit as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const stripped = stripTypeScriptTypes(prefix + source + suffix);
    return stripped.slice(prefix.length, stripped.length - suffix.length);
  } finally {
    process.emitWarning = emit;
  }
}

/**
 * The Python arm, kept out of the handler so the handler stays readable.
 *
 * Not the isolate: this is the interpreter on the machine, with that machine's
 * disk and network. It stays off until an operator names one, and the refusal
 * says which setting turns it on rather than failing obscurely.
 */
async function runPythonStep(
  ctx: Parameters<NodeHandler>[0],
  code: string,
  input: unknown,
  timeoutMs: number,
): ReturnType<NodeHandler> {
  const binary = resolvePythonBinary(process.env);
  if (!binary) {
    return {
      status: 500,
      message:
        'this step is set to Python, and Python is not enabled on this Metis. Set '
        + 'METIS_PYTHON to an interpreter path, or to "auto" to find one. Note that '
        + 'Python steps are NOT sandboxed the way JavaScript steps are: they can '
        + 'read this machine and reach the network.',
    };
  }
  const outcome = await runPython(binary, code, input, timeoutMs);
  if (outcome.status === 'ok') {
    return {
      status: 200,
      message: 'ok',
      nodeData: stateEnvelope(ctx.nodeRef.id, ctx.nodeRef.type, outcome.value),
    };
  }
  return { status: outcome.status === 'timeout' ? 504 : 500, message: outcome.error };
}

export function createCodeNodeHandler(): NodeHandler {
  return async (ctx) => {
    const config = ctx.nodeRef.config as CodeNodeConfig;
    const code = String(config.code ?? config.script ?? '');
    if (code.trim() === '') {
      return { status: 500, message: 'code node has no code configured' };
    }
    const configuredTimeout = Number(config.timeout ?? config.timeoutMs);
    const timeoutMs = Math.min(
      configuredTimeout > 0 ? configuredTimeout : SANDBOX_DEFAULT_TIMEOUT_MS,
      SANDBOX_MAX_TIMEOUT_MS,
    );
    // A configured "Data in" wins, because that is the wired-up answer: in a
    // real workflow it holds a {{...}} reference to an upstream step. With none
    // configured, fall back to the RUN input, which every handler already
    // receives and switch and logic have always read.
    //
    // This is what makes the inspector's Test tab honest. It sends the step
    // alone with your sample JSON as the run input, and before this the code
    // step never looked at it - so testing `input.n` reported "Cannot read
    // properties of null" and the Sample input box changed nothing at all.
    const inputPayload = config.inputData ?? config.input ?? ctx.inputData;
    const language = String(config.language ?? DEFAULT_LANGUAGE).toLowerCase();

    if (language === 'python') {
      return runPythonStep(ctx, code, inputPayload, timeoutMs);
    }

    let source = code;
    if (language === 'typescript') {
      try {
        source = stripTypes(code);
      } catch (error) {
        return {
          status: 500,
          message: `this step will not parse as TypeScript: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    } else if (language !== 'javascript') {
      // Named, not ignored. Running an unknown language as JavaScript is how
      // `python` silently became JavaScript in the first place.
      return {
        status: 500,
        message: `this step is set to "${language}", which Metis cannot run. Choose javascript, typescript or python.`,
      };
    }

    const result = await runUserCode(source, inputPayload, timeoutMs);
    if (result.status === 'ok') {
      return { status: 200, message: 'ok', nodeData: stateEnvelope(ctx.nodeRef.id, ctx.nodeRef.type, result.value) };
    }
    // timeout -> 504, oom/error -> 500 (mirrors Helix's status classification).
    return { status: result.status === 'timeout' ? 504 : 500, message: result.error ?? result.status };
  };
}
