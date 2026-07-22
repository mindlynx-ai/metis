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
import { describe, it, expect } from 'vitest';
import { FakeCredentialPort } from '../fakes.js';
import { resolveSecretTokens } from '../secret-resolution.js';

const SECRET_ID = 'dddddddd-1111-4222-8333-444444444444';

describe('resolveSecretTokens at the CredentialPort boundary', () => {
  const credentials = new FakeCredentialPort({ [`t1/${SECRET_ID}`]: 'plain-secret' });

  it('substitutes secret tokens only at dispatch time', async () => {
    const resolved = (await resolveSecretTokens(
      { auth: `Bearer {{secrets.${SECRET_ID}}}` },
      't1',
      credentials,
    )) as Record<string, unknown>;
    expect(resolved.auth).toBe('Bearer plain-secret');
  });

  it('escapes quotes in secret values so the config stays valid JSON', async () => {
    const quoted = new FakeCredentialPort({ [`t1/${SECRET_ID}`]: 'va"lue' });
    const resolved = (await resolveSecretTokens(
      { auth: `{{secrets.${SECRET_ID}}}` },
      't1',
      quoted,
    )) as Record<string, unknown>;
    expect(resolved.auth).toBe('va"lue');
  });

  it('rejects when a referenced secret is missing', async () => {
    await expect(
      resolveSecretTokens({ x: '{{secrets.eeeeeeee-1111-4222-8333-444444444444}}' }, 't1', credentials),
    ).rejects.toThrow(/not defined/);
  });

  it('leaves configs without secret tokens untouched', async () => {
    const config = { plain: 1 };
    expect(await resolveSecretTokens(config, 't1', credentials)).toBe(config);
  });
});
