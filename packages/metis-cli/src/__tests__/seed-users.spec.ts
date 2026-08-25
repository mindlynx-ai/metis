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
import { assertServableSecret, seedUsers } from '../seed-users.js';

/** A secret nobody could guess, for the cases that are not about the secret. */
const SET = { METIS_ADMIN_SECRET: 's3cr3t' };

describe('assertServableSecret', () => {
  it('refuses the published default secret, whatever METIS_ENV says', () => {
    // The default used to be asserted as a FEATURE ("defaults to admin/metis for
    // local development") and guarded only when METIS_ENV=production, which
    // nothing sets on the way anyone starts Metis. So a plain boot served as
    // admin/metis, and that secret is in this repository for anyone to read.
    expect(() => assertServableSecret({})).toThrow(/METIS_ADMIN_SECRET/);
    expect(() => assertServableSecret({ METIS_ADMIN_SECRET: 'metis' })).toThrow(/METIS_ADMIN_SECRET/);
    expect(() => assertServableSecret({ METIS_ENV: 'development' })).toThrow(/METIS_ADMIN_SECRET/);
    expect(() => assertServableSecret({ METIS_ENV: 'production' })).toThrow(/METIS_ADMIN_SECRET/);
  });

  it('names the way out in the refusal', () => {
    // An error that only says no costs the reader a trip to the source.
    expect(() => assertServableSecret({})).toThrow(/METIS_INSECURE_DEMO/);
  });

  it('permits the default only when the operator says so in as many words', () => {
    expect(() => assertServableSecret({ METIS_INSECURE_DEMO: 'true' })).not.toThrow();
  });

  it('treats anything other than the exact opt-in as no opt-in', () => {
    // A truthy-looking value must not be enough: this is the one guard between
    // a reachable port and a published password.
    for (const value of ['1', 'yes', 'TRUE', 'true ', '']) {
      expect(() => assertServableSecret({ METIS_INSECURE_DEMO: value }), value).toThrow(
        /METIS_ADMIN_SECRET/,
      );
    }
  });

  it('says nothing when a real secret is set', () => {
    expect(() => assertServableSecret(SET)).not.toThrow();
  });

  it('does not gate the commands that only read the project', () => {
    // seedUsers is reached by every subcommand, so the refusal lives in the
    // serving path instead: `metis triggers list` must not demand a secret to
    // read a local file, or the friction teaches people to set the opt-in
    // permanently and the guard stops meaning anything.
    expect(() => seedUsers({})).not.toThrow();
    expect(seedUsers({})).toEqual([{ userId: 'admin', secret: 'metis', role: 'admin' }]);
  });
});

describe('seedUsers', () => {
  it('boots with a non-default admin secret', () => {
    expect(seedUsers(SET)).toEqual([{ userId: 'admin', secret: 's3cr3t', role: 'admin' }]);
    expect(seedUsers({ ...SET, METIS_ENV: 'production' })).toEqual([
      { userId: 'admin', secret: 's3cr3t', role: 'admin' },
    ]);
  });

  it('seeds a demo user (editor by default) when both env vars are set', () => {
    const users = seedUsers({
      ...SET,
      METIS_ENV: 'production',
      METIS_DEMO_USER: 'lisa',
      METIS_DEMO_SECRET: 'demo-pass',
    });
    expect(users).toContainEqual({ userId: 'lisa', secret: 'demo-pass', role: 'editor' });
  });

  it('honours a valid demo role and falls back to editor for an invalid one', () => {
    expect(
      seedUsers({ ...SET, METIS_DEMO_USER: 'v', METIS_DEMO_SECRET: 'p', METIS_DEMO_ROLE: 'viewer' })[1],
    ).toMatchObject({ role: 'viewer' });
    expect(
      seedUsers({ ...SET, METIS_DEMO_USER: 'v', METIS_DEMO_SECRET: 'p', METIS_DEMO_ROLE: 'wizard' })[1],
    ).toMatchObject({ role: 'editor' });
  });

  it('ignores a half-configured demo user (only one of the two vars)', () => {
    expect(seedUsers({ ...SET, METIS_DEMO_USER: 'lisa' })).toHaveLength(1);
    expect(seedUsers({ ...SET, METIS_DEMO_SECRET: 'p' })).toHaveLength(1);
  });
});

/**
 * A blank secret is UNSET, not a password.
 *
 * `METIS_ADMIN_SECRET=` in a .env, or an unset shell variable expanding to
 * nothing, used to sail past the guard: it is not equal to the published
 * default, so the check passed and admin was seeded with an EMPTY password.
 * That is worse than the default it exists to refuse, and the scaffolded .env
 * ships exactly that line for the operator to fill in.
 */
describe('a blank admin secret', () => {
  it.each(['', '   ', '\t'])('is refused rather than accepted as a password (%j)', (value) => {
    expect(() => assertServableSecret({ METIS_ADMIN_SECRET: value })).toThrow(
      /METIS_ADMIN_SECRET/,
    );
  });

  it('is still refused when the demo opt-in is off', () => {
    expect(() =>
      assertServableSecret({ METIS_ADMIN_SECRET: '', METIS_INSECURE_DEMO: 'false' }),
    ).toThrow();
  });

  it('never seeds an admin who can be signed in as with no password', () => {
    const admin = seedUsers({ METIS_ADMIN_SECRET: '   ' }).find((u) => u.userId === 'admin');
    expect(admin?.secret).not.toBe('');
    expect(admin?.secret.trim()).not.toBe('');
  });

  it('leaves a real secret alone, including one with spaces inside it', () => {
    expect(() => assertServableSecret({ METIS_ADMIN_SECRET: 'correct horse battery' })).not.toThrow();
    const admin = seedUsers({ METIS_ADMIN_SECRET: 'correct horse battery' }).find(
      (u) => u.userId === 'admin',
    );
    expect(admin?.secret).toBe('correct horse battery');
  });
});

