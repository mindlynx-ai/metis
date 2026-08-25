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
 * Verify the RELAY's signature on a delivery it handed us.
 *
 * This is a second signature, beside the provider's, not instead of it. The
 * provider's proves the payload is genuinely from Stripe; this one proves the
 * delivery genuinely came from our relay and not from anything else that can
 * reach this instance. Both are checked, and neither substitutes for the other.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyRelaySignature(
  secret: string,
  delivery: { id: string; receivedAt: string; body: string; signature: string },
): boolean {
  const expected = createHmac('sha256', secret)
    .update(`${delivery.id}.${delivery.receivedAt}.${delivery.body}`)
    .digest('base64');
  const left = Buffer.from(expected);
  const right = Buffer.from(delivery.signature ?? '');
  // Length first: timingSafeEqual throws on a mismatch rather than answering.
  return left.length === right.length && timingSafeEqual(left, right);
}
