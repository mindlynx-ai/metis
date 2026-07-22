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
 * The cloud standing, shared by every surface that shows an uplift
 * affordance: the offers manifest (the storefront), the account's
 * capabilities, and the cloud state ('disabled' = the kill switch, which
 * hides the Account nav, the /account route and every palette affordance).
 * One fetch per session; connect/disconnect calls refresh().
 */
import { create } from 'zustand';
import { upliftApi, type OfferEntry } from './uplift-api.js';

export interface UpliftState {
  loaded: boolean;
  offers: OfferEntry[];
  capabilities: string[];
  cloud: 'ok' | 'offline' | 'disabled';
  account: { email?: string } | null;
  /** Fetch (or re-fetch after connect/disconnect); safe to call repeatedly. */
  refresh(): Promise<void>;
}

let inflight: Promise<void> | undefined;

export const useUplift = create<UpliftState>((set) => ({
  loaded: false,
  offers: [],
  capabilities: [],
  // Until the server answers, behave as if the kill switch is on: no
  // affordances flash for an instance that turns out to be air-gapped.
  cloud: 'disabled',
  account: null,

  refresh() {
    inflight ??= (async () => {
      try {
        const [offers, entitlements] = await Promise.all([
          upliftApi.offers(),
          upliftApi.entitlements(),
        ]);
        set({
          loaded: true,
          offers: offers.capabilities,
          capabilities: entitlements.capabilities ?? [],
          cloud: entitlements.cloud ?? 'disabled',
          account: entitlements.account,
        });
      } catch {
        // An unreachable control plane reads as the kill switch: show nothing.
        set({ loaded: true, offers: [], capabilities: [], cloud: 'disabled', account: null });
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  },
}));

/** Load once on mount (components call this; repeated mounts reuse the fetch). */
export function ensureUplift(): void {
  if (!useUplift.getState().loaded) {
    useUplift
      .getState()
      .refresh()
      .catch(() => undefined);
  }
}
