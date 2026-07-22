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
 * The users seeded into the single-tenant identity at boot, derived from the
 * environment. Two demo-safety rules live here:
 *
 *   - In production (`METIS_ENV=production`) a non-default admin secret is
 *     mandatory; the app refuses to boot on the default, so a public demo can
 *     never sit behind admin/metis.
 *   - An optional extra user (a tester) is seeded when both `METIS_DEMO_USER`
 *     and `METIS_DEMO_SECRET` are set - editor role by default.
 */
import type { Role, UserSeed } from '@mindlynx/metis-ports';

const DEFAULT_ADMIN_SECRET = 'metis';
const ROLES: ReadonlySet<Role> = new Set<Role>(['admin', 'editor', 'viewer']);

export function seedUsers(env: Record<string, string | undefined>): UserSeed[] {
  const adminSecret = env.METIS_ADMIN_SECRET ?? DEFAULT_ADMIN_SECRET;
  if (env.METIS_ENV === 'production' && adminSecret === DEFAULT_ADMIN_SECRET) {
    throw new Error(
      'METIS_ADMIN_SECRET must be set to a non-default value when METIS_ENV=production',
    );
  }

  const users: UserSeed[] = [{ userId: 'admin', secret: adminSecret, role: 'admin' }];

  const demoUser = env.METIS_DEMO_USER;
  const demoSecret = env.METIS_DEMO_SECRET;
  if (demoUser && demoSecret) {
    const requested = env.METIS_DEMO_ROLE;
    const role: Role = requested && ROLES.has(requested as Role) ? (requested as Role) : 'editor';
    users.push({ userId: demoUser, secret: demoSecret, role });
  }
  return users;
}
