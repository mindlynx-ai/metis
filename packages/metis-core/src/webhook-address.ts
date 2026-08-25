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
 * Where a webhook trigger actually listens, and whether the sender can reach
 * it.
 *
 * Binding a webhook used to answer `POST to /hooks/trg_...`: a path, with no
 * host, and nothing about reachability. Metis defaults to loopback, so on the
 * machine somebody just installed it on, that address means "this computer and
 * nothing else" - and Stripe, GitHub and every other sender is somewhere else.
 * The trigger arms, the URL looks real, and the call never arrives. Nothing in
 * the product said so.
 *
 * Pure, so the rule is unit-tested without a server.
 */

/** Hosts that only ever mean "the machine this is running on". */
function isLoopback(host: string): boolean {
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name.endsWith('.localhost');
}

/** The full URL a sender would POST to, as this request reached us. */
export function webhookUrl(origin: string, triggerId: string): string {
  const base = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  return `${base}/hooks/${triggerId}`;
}

/**
 * What to tell whoever just bound the trigger. On a loopback address that is a
 * warning, because the commonest next step - pasting this into a provider's
 * dashboard - cannot work.
 */
export function webhookHint(origin: string, triggerId: string): string {
  const url = webhookUrl(origin, triggerId);
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    host = origin;
  }
  if (!isLoopback(host)) return `POST to ${url}`;
  return (
    `POST to ${url} - reachable from THIS MACHINE ONLY. `
    + 'A provider on the internet (Stripe, GitHub, and so on) cannot reach a loopback address. '
    + 'To receive real deliveries, put a public address in front of Metis: a tunnel '
    + '(`cloudflared tunnel --url http://localhost:3000`, `ngrok http 3000`) for testing, '
    + 'or host Metis somewhere with its own address and set METIS_HOST. '
    + 'Then use that address in place of this one.'
  );
}
