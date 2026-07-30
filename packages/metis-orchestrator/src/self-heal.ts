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
 * Self-healing client holder, ported from the origin
 * temporalClient.ts hardening: a lazily built singleton client; when a
 * call fails with a stale-gRPC-channel signature the client is rebuilt
 * once and the call retried. Ordinary application errors pass through.
 */
const STALE_CHANNEL_SIGNATURES =
  /channel has been shut down|UNAVAILABLE|connection (?:refused|reset|closed)|GOAWAY|shutdown/i;

export class SelfHealing<TClient> {
  private client: Promise<TClient> | undefined;

  /**
   * `close` releases whatever the builder acquired. Without it a heal drops the
   * client reference and leaks the gRPC channel it was holding, one per heal.
   * Optional because a builder that hands back an injected client has nothing
   * of its own to release.
   */
  constructor(
    private readonly build: () => Promise<TClient>,
    private readonly close?: (client: TClient) => Promise<void> | void,
  ) {}

  private clientPromise(): Promise<TClient> {
    if (!this.client) {
      // A REJECTED promise is not undefined, so `??=` cached the failure for
      // the process lifetime: one slow first connect (a dev Temporal a second
      // late accepting gRPC) and every later start, cancel, list, reset and
      // schedule rejected with that same stale error for ever, long after
      // Temporal was healthy. Retract the attempt as it fails so the next call
      // builds again.
      const pending: Promise<TClient> = this.build().catch((error: unknown) => {
        // Only retract OUR attempt: a reset in the meantime has already put a
        // newer one in place and that one is not ours to drop.
        if (this.client === pending) this.client = undefined;
        throw error;
      });
      this.client = pending;
    }
    return this.client;
  }

  async reset(): Promise<void> {
    const held = this.client;
    this.client = undefined;
    if (!held || !this.close) return;
    // A client that never built has nothing to close, and its rejection is the
    // caller's to report, not ours to re-raise from here.
    await held.then((client) => this.close?.(client)).catch(() => undefined);
  }

  async withSelfHeal<T>(operation: (client: TClient) => Promise<T>): Promise<T> {
    try {
      // Inside the try: a build that fails with a stale-channel signature is
      // exactly the case this class exists for, and awaiting it outside meant
      // the one path that could heal a bad connect never saw it.
      const client = await this.clientPromise();
      return await operation(client);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!STALE_CHANNEL_SIGNATURES.test(message)) throw error;
      await this.reset();
      const rebuilt = await this.clientPromise();
      return operation(rebuilt);
    }
  }
}
