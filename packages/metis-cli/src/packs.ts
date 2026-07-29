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
 * Node packs: extra handler bundles a runtime loads at boot, named by
 * METIS_PACKS as a comma-separated list of module specifiers.
 *
 * This exists because the open build must not be able to reach a paid package,
 * and the module-boundary gate enforces that by scanning import specifiers. A
 * static import of a paid pack would fail the gate, and rightly so: the whole
 * point of the edition split is that the open build physically cannot contain
 * the paid code. So the specifier is data, resolved at run time, and a runtime
 * that has no packs configured behaves exactly as it did before.
 *
 * A pack is any module exporting `registerPack(registry)`. That is the entire
 * contract, deliberately: the registry is the seam the engine already
 * dispatches through, so a pack needs no privileged access to anything else.
 */
import type { NodeHandlerRegistry } from '@mindlynx/metis-ports';

/** What a loadable pack must export. */
export interface NodePack {
  registerPack(registry: NodeHandlerRegistry): unknown;
}

/**
 * Split the env value into specifiers, tolerating spaces and trailing commas.
 * A specifier therefore cannot itself contain a comma, which rules out data:
 * URLs and is fine: npm package names cannot contain one either.
 */
export function parsePackSpecs(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function isPack(loaded: unknown): loaded is NodePack {
  return typeof (loaded as NodePack | undefined)?.registerPack === 'function';
}

/**
 * Load every configured pack into the registry, in order, and return what was
 * registered so the caller can say so out loud.
 *
 * Failure is FATAL, on purpose. A paid instance that booted without its paid
 * handlers would look healthy and then refuse the very capability it was sold,
 * one workflow at a time, with an upgrade message aimed at someone who has
 * already upgraded. Refusing to start is the kinder failure: it is loud, it is
 * immediate, and it cannot be mistaken for the product working.
 */
export async function loadPacks(
  registry: NodeHandlerRegistry,
  value: string | undefined,
): Promise<string[]> {
  const specs = parsePackSpecs(value);
  const loadedNames: string[] = [];
  for (const spec of specs) {
    let loaded: unknown;
    try {
      // The specifier is a variable, never a literal: see the note above on
      // why the boundary gate must not be able to see a paid package here.
      loaded = await import(spec);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `METIS_PACKS names "${spec}", which this build cannot load: ${reason}. ` +
          'An open build does not contain the paid packs; build the helix edition to use them.',
      );
    }
    if (!isPack(loaded)) {
      throw new Error(
        `METIS_PACKS names "${spec}", which exports no registerPack(registry) and so is not a node pack.`,
      );
    }
    loaded.registerPack(registry);
    loadedNames.push(spec);
  }
  return loadedNames;
}
