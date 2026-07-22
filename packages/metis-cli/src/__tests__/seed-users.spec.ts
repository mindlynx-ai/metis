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
import { seedUsers } from '../seed-users.js';

describe('seedUsers', () => {
  it('defaults to admin/metis for local development', () => {
    expect(seedUsers({})).toEqual([{ userId: 'admin', secret: 'metis', role: 'admin' }]);
  });

  it('refuses to boot on the default admin secret in production', () => {
    expect(() => seedUsers({ METIS_ENV: 'production' })).toThrow(/METIS_ADMIN_SECRET/);
    expect(() => seedUsers({ METIS_ENV: 'production', METIS_ADMIN_SECRET: 'metis' })).toThrow(
      /METIS_ADMIN_SECRET/,
    );
  });

  it('boots in production with a non-default admin secret', () => {
    const users = seedUsers({ METIS_ENV: 'production', METIS_ADMIN_SECRET: 's3cr3t' });
    expect(users).toEqual([{ userId: 'admin', secret: 's3cr3t', role: 'admin' }]);
  });

  it('seeds a demo user (editor by default) when both env vars are set', () => {
    const users = seedUsers({
      METIS_ENV: 'production',
      METIS_ADMIN_SECRET: 's3cr3t',
      METIS_DEMO_USER: 'lisa',
      METIS_DEMO_SECRET: 'demo-pass',
    });
    expect(users).toContainEqual({ userId: 'lisa', secret: 'demo-pass', role: 'editor' });
  });

  it('honours a valid demo role and falls back to editor for an invalid one', () => {
    expect(
      seedUsers({ METIS_DEMO_USER: 'v', METIS_DEMO_SECRET: 'p', METIS_DEMO_ROLE: 'viewer' })[1],
    ).toMatchObject({ role: 'viewer' });
    expect(
      seedUsers({ METIS_DEMO_USER: 'v', METIS_DEMO_SECRET: 'p', METIS_DEMO_ROLE: 'wizard' })[1],
    ).toMatchObject({ role: 'editor' });
  });

  it('ignores a half-configured demo user (only one of the two vars)', () => {
    expect(seedUsers({ METIS_DEMO_USER: 'lisa' })).toHaveLength(1);
    expect(seedUsers({ METIS_DEMO_SECRET: 'p' })).toHaveLength(1);
  });
});
