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
 *   - An optional extra user (a tester) is seeded when both `METIS_DEMO_USER`
 *     and `METIS_DEMO_SECRET` are set - editor role by default.
 *
 * The default admin secret is refused by `assertServableSecret`, which the two
 * commands that LISTEN call before they bind. The check deliberately does not
 * live in `seedUsers`: every CLI subcommand builds a runtime, so refusing here
 * would make `metis triggers list` demand a secret to read a local file. That
 * is friction with no security behind it, and friction is what makes somebody
 * set the insecure flag permanently and defeat the point.
 */
import type { Role, UserSeed } from '@mindlynx/metis-ports';

const DEFAULT_ADMIN_SECRET = 'metis';
const ROLES: ReadonlySet<Role> = new Set<Role>(['admin', 'editor', 'viewer']);

/** True when the operator has said, in as many words, that they want the
 *  well-known secret anyway (a throwaway demo, a workshop, a screenshot). */
export function insecureDemoOptIn(env: Record<string, string | undefined>): boolean {
  return env.METIS_INSECURE_DEMO === 'true';
}

/**
 * Refuse to serve on the published default secret. Called by the commands that
 * open a port, never by the ones that only read the project.
 *
 * It used to be guarded only when `METIS_ENV=production`, which nothing sets on
 * the way anyone actually starts Metis - so a plain `metis up` came up as
 * admin/metis, on a port that was bound to every interface, with the password
 * sitting in a public repository.
 */
export function assertServableSecret(env: Record<string, string | undefined>): void {
  const adminSecret = env.METIS_ADMIN_SECRET ?? DEFAULT_ADMIN_SECRET;
  if (adminSecret !== DEFAULT_ADMIN_SECRET || insecureDemoOptIn(env)) return;
  throw new Error(
    'METIS_ADMIN_SECRET must be set before Metis will serve: the built-in '
      + 'default is published in the source, so anyone who can reach this port '
      + 'would be an administrator. Set METIS_ADMIN_SECRET to something only you '
      + 'know, or set METIS_INSECURE_DEMO=true if you genuinely want the default '
      + 'on a throwaway instance.',
  );
}

export function seedUsers(env: Record<string, string | undefined>): UserSeed[] {
  const adminSecret = env.METIS_ADMIN_SECRET ?? DEFAULT_ADMIN_SECRET;

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
