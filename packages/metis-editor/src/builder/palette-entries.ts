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
 * Which catalogue entries the picker may actually add.
 *
 * The catalogue is one file across editions, so it also describes steps this
 * build cannot run: a paid step that runs LOCALLY (an approval, not a cloud
 * job) ships its entry here but its handler only in the paid pack. Offering
 * it as an ordinary step would let someone build a workflow that answers
 * "not in this edition" at run time, which is the silent failure the
 * upgrade path exists to avoid. It shows as a locked card instead.
 */
import type { CatalogueEntry } from '../api.js';

/** True when the entry's handler cannot be in this build: paid, and local
 *  (a 'both' entry always has a local backend, so it stays addable). */
export function isLockedCapability(entry: CatalogueEntry, capabilities: string[]): boolean {
  if (!entry.entitlement) return false;
  if (entry.execution === 'both') return false;
  return !capabilities.includes(entry.entitlement);
}

/** The entries the picker offers: ready, not an alias, and runnable here. */
export function addableEntries(catalogue: CatalogueEntry[], capabilities: string[]): CatalogueEntry[] {
  return catalogue.filter(
    (entry) =>
      !entry.alias_of &&
      entry.handler_status === 'ready' &&
      !isLockedCapability(entry, capabilities),
  );
}
