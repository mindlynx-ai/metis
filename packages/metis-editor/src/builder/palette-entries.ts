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
 * The catalogue is one file across editions, so it can describe a step this
 * build cannot run: one whose entitlement is paid AND whose work is local, so
 * there is no local backend to fall back to. Offering that as an ordinary step
 * would let someone build a workflow that answers "not in this edition" at run
 * time, which is the silent failure the upgrade path exists to avoid, so it
 * shows as a locked card instead.
 *
 * No shipped entry is in that state today - the sign-off gate was, until it
 * became part of the product - but the rule stays, because the day one is
 * added is the day it matters.
 */
import type { CatalogueEntry } from '../api.js';

/** True when the entry's handler cannot be in this build: entitled, and local
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
