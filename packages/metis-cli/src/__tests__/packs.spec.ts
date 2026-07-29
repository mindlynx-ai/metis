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
 * The pack loader. The behaviour worth pinning is not the happy path, it is
 * the refusal: a paid instance that boots without its paid handlers looks
 * healthy and then denies the capability it was sold, one run at a time.
 */
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NodeHandlerRegistry } from '@mindlynx/metis-ports';
import { loadPacks, parsePackSpecs } from '../packs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('parsePackSpecs', () => {
  it('reads a comma-separated list, tolerating spaces and a trailing comma', () => {
    expect(parsePackSpecs(' a , b,, c, ')).toEqual(['a', 'b', 'c']);
  });

  it('treats unset and empty as no packs, so an open runtime is unchanged', () => {
    expect(parsePackSpecs(undefined)).toEqual([]);
    expect(parsePackSpecs('')).toEqual([]);
    expect(parsePackSpecs('   ')).toEqual([]);
  });
});

describe('loadPacks', () => {
  it('registers nothing and stays quiet when no packs are configured', async () => {
    const registry = new NodeHandlerRegistry();
    await expect(loadPacks(registry, undefined)).resolves.toEqual([]);
  });

  it('refuses to boot when a named pack cannot be loaded', async () => {
    // The exact case that matters: an OPEN image told to load a paid pack it
    // does not physically contain. Booting anyway would sell approvals and
    // then refuse them at run time, with an upgrade prompt for someone who
    // has already paid.
    const registry = new NodeHandlerRegistry();
    await expect(loadPacks(registry, '@mindlynx/definitely-not-installed')).rejects.toThrow(
      /cannot load|build the helix edition/i,
    );
  });

  it('refuses a module that is not a pack, rather than ignoring it', async () => {
    // node:path loads fine and exports no registerPack. Silently skipping it
    // would be the same failure as above, wearing a success message.
    const registry = new NodeHandlerRegistry();
    await expect(loadPacks(registry, 'node:path')).rejects.toThrow(/registerPack/);
  });

  it('actually registers a pack handler, and names what it loaded', async () => {
    // A real module on disk, loaded by URL, so the whole path runs: dynamic
    // specifier, shape check, call. A data: URL would have been neater but
    // cannot work here, and finding that out was worth the detour: those URLs
    // contain commas, which is exactly what separates one specifier from the
    // next. Package specifiers cannot contain commas, so the parser is right
    // and this test was wrong.
    const pack = pathToFileURL(join(__dirname, 'fixtures', 'probe-pack.mjs')).href;
    const registry = new NodeHandlerRegistry();
    expect(registry.canExecute('pack-probe')).toBe(false);

    const loaded = await loadPacks(registry, pack);

    expect(registry.canExecute('pack-probe')).toBe(true);
    expect(loaded).toEqual([pack]);
  });
});
