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
 * The uplift slice of the API client: the offers manifest (the public
 * storefront), the extended entitlements view, and the Helix account
 * connect/disconnect surface. Same bearer + error rules as api.ts.
 */
import { request } from './api.js';

/** One capability from the offers manifest (the public storefront). */
export interface OfferEntry {
  id: string;
  title: string;
  description: string;
  state: 'coming-soon' | 'beta' | 'available';
  ctaUrl: string;
  message?: string;
}

/** The extended entitlements view: shim + the account's cloud standing. */
export interface EntitlementsView {
  capabilities: string[];
  account: { email?: string } | null;
  cloud: 'ok' | 'offline' | 'disabled';
}

export const upliftApi = {
  offers: () => request<{ capabilities: OfferEntry[]; source?: string }>('GET', '/api/offers'),
  entitlements: () => request<EntitlementsView>('GET', '/api/entitlements'),
  account: () =>
    request<{ connected: boolean; account?: { email?: string } }>('GET', '/api/account'),
  connectAccount: () => request<{ authorizeUrl: string }>('POST', '/api/account/connect'),
  disconnectAccount: () => request<{ connected: boolean }>('DELETE', '/api/account'),
};
