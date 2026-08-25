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

/** What a purchasable capability costs. Absent until it can be bought. */
export interface OfferPrice {
  /** Minor units (pence), so money never rounds through a float. */
  amount: number;
  currency: string;
  interval: 'month' | 'year';
}

/** One capability from the offers manifest (the public storefront). */
export interface OfferEntry {
  id: string;
  title: string;
  description: string;
  state: 'coming-soon' | 'beta' | 'available';
  ctaUrl: string;
  message?: string;
  price?: OfferPrice;
  /** 'step' shows in the builder palette; 'plan' is about the shape of the
   *  instance and belongs only on the account page. Absent means 'step'. */
  scope?: 'step' | 'plan';
  /** The palette strip's lead-in: what the LOCAL version does. Each capability
   *  states its own, because they are limited in different ways - the data node
   *  by size, a webhook by reach. Absent keeps the original sentence. */
  local?: string;
  /** What to say once entitled. Absent keeps the original sentence. */
  entitledHint?: string;
}

/**
 * Mirrors formatOfferPrice in metis-ports. The editor cannot import from the
 * ports package (it is a browser bundle and the boundary gate enforces that),
 * so the one thing that must not drift between them is pinned by a test.
 */
export function formatOfferPrice(price: OfferPrice): string {
  const symbols: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };
  const symbol = symbols[price.currency] ?? `${price.currency} `;
  const major = price.amount / 100;
  const shown = Number.isInteger(major) ? String(major) : major.toFixed(2);
  return `${symbol}${shown}/${price.interval}`;
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
