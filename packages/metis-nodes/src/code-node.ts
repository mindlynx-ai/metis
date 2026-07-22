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
import { createRequire } from 'node:module';
import type ivmType from 'isolated-vm';
import { stateEnvelope, type NodeHandler } from '@mindlynx/metis-ports';

// isolated-vm is a native module; createRequire keeps bundlers away.
const requireModule = createRequire(import.meta.url);
const ivm = requireModule('isolated-vm') as typeof ivmType;

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
    new ivm.Reference((input: string, algo?: string): string => {
      const algorithm = algo === 'md5' ? 'md5' : 'sha256';
      return createHash(algorithm).update(String(input)).digest('hex');
    }),
  );
  await context.global.set('__metis_uuid', new ivm.Reference((): string => randomUUID()));
  await context.global.set(
    '__metis_parseDate',
    new ivm.Reference((input: string): string => {
      const parsed = new Date(input);
      if (Number.isNaN(parsed.getTime())) throw new Error(`parseDate: cannot parse '${input}'`);
      return parsed.toISOString();
    }),
  );
  await context.global.set(
    '__metis_formatDate',
    new ivm.Reference((input: string, locale?: string): string => {
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
  const isolate = new ivm.Isolate({ memoryLimit: SANDBOX_MEMORY_MB });
  try {
    const context = await isolate.createContext();
    await context.eval(DENIALS, { timeout: 100 });
    await injectHelpers(context);
    await context.eval(`const input = ${JSON.stringify(input ?? null)};`, { timeout: 100 });

    const wrapped = `
      (async () => {
        const __value = await (async () => { ${code}\n })();
        return __value === undefined ? '__metis_undefined__' : JSON.stringify(__value);
      })()
    `;
    const resultJson = (await context.eval(wrapped, {
      timeout: timeoutMs,
      promise: true,
    })) as string;
    return {
      status: 'ok',
      value: resultJson === '__metis_undefined__' ? undefined : JSON.parse(resultJson),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
    const inputPayload = config.inputData ?? config.input;
    const result = await runUserCode(code, inputPayload, timeoutMs);
    if (result.status === 'ok') {
      return { status: 200, message: 'ok', nodeData: stateEnvelope(ctx.nodeRef.id, ctx.nodeRef.type, result.value) };
    }
    // timeout -> 504, oom/error -> 500 (mirrors Helix's status classification).
    return { status: result.status === 'timeout' ? 504 : 500, message: result.error ?? result.status };
  };
}
