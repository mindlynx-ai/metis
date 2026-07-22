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
 * The loop node's config parsing (pure, workflow-safe). `items` usually arrives
 * as a {{node-x.data.rows}} reference, and the substitution engine embeds
 * object/array values into string fields as JSON STRINGS - so the parse must
 * accept a real array or a JSON string of one. Anything else (including an
 * unresolved {{...}} token) is a clear failure, never a silent empty loop.
 */

export const LOOP_DEFAULT_MAX_ITERATIONS = 1000;
export const LOOP_MAX_ITERATIONS_CLAMP = 10_000;
/** Parent-side cap on the accumulated results payload. */
export const LOOP_RESULTS_BYTES = 256 * 1024;
/** Child-side cap on the leaf outputs one iteration returns. */
export const LOOP_CHILD_OUTPUT_BYTES = 32 * 1024;

export interface LoopPlan {
  items: unknown[];
  batchSize: number;
  maxIterations: number;
  iterations: number;
}

const intOr = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
};

/**
 * Coerce an (already-substituted) config value to an array: a real array, or
 * the JSON string substitution produces for an array reference. Shared by the
 * loop, filter and compare nodes. `label` names the field in errors.
 */
export function coerceArray(value: unknown, label: string): { items: unknown[] } | { error: string } {
  let items = value;
  if (typeof items === 'string') {
    const text = items.trim();
    if (text.startsWith('{{')) {
      return { error: `${label} reference did not resolve: ${text.slice(0, 80)}` };
    }
    try {
      items = JSON.parse(text);
    } catch {
      return { error: `${label} did not resolve to an array (got a non-JSON string)` };
    }
  }
  if (!Array.isArray(items)) {
    return { error: `${label} did not resolve to an array` };
  }
  return { items };
}

/** Parse the (already-substituted) loop config into a plan, or an error. */
export function parseLoopConfig(resolved: unknown): { plan: LoopPlan } | { error: string } {
  const config = (resolved ?? {}) as Record<string, unknown>;
  const coerced = coerceArray(config.items, 'loop items');
  if ('error' in coerced) return { error: coerced.error };
  const items = coerced.items;
  const batchSize = intOr(config.batchSize, 1);
  const maxIterations = Math.min(
    intOr(config.maxIterations, LOOP_DEFAULT_MAX_ITERATIONS),
    LOOP_MAX_ITERATIONS_CLAMP,
  );
  const iterations = Math.ceil(items.length / batchSize);
  if (iterations > maxIterations) {
    // Silent truncation would be a data bug: fail before spawning anything.
    return { error: `loop needs ${iterations} iterations but maxIterations is ${maxIterations}` };
  }
  return { plan: { items, batchSize, maxIterations, iterations } };
}
