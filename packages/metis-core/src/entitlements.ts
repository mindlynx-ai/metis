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
 * The entitlements shim: reports the open feature set as on.
 * This is the seam a hosted edition later swaps for a licensing
 * service; the open build ignores any claim to a paid entitlement, so
 * a tampered configuration cannot switch paid features on.
 */
export const OPEN_ENTITLEMENTS = [
  'workflows',
  'editor',
  'webhooks',
  'schedules',
  'catalogue',
  'observability-local',
] as const;

export type OpenEntitlement = (typeof OPEN_ENTITLEMENTS)[number];

export interface EntitlementsReport {
  edition: 'open';
  entitlements: Record<string, boolean>;
}

export class EntitlementsShim {
  isEnabled(name: string): boolean {
    return (OPEN_ENTITLEMENTS as readonly string[]).includes(name);
  }

  report(): EntitlementsReport {
    const entitlements: Record<string, boolean> = {};
    for (const name of OPEN_ENTITLEMENTS) entitlements[name] = true;
    // Claims outside the open set are deliberately dropped: the open
    // build cannot be talked into paid features by configuration.
    return { edition: 'open', entitlements };
  }
}
