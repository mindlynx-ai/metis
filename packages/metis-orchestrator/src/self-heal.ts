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

  constructor(private readonly build: () => Promise<TClient>) {}

  private clientPromise(): Promise<TClient> {
    this.client ??= this.build();
    return this.client;
  }

  reset(): void {
    this.client = undefined;
  }

  async withSelfHeal<T>(operation: (client: TClient) => Promise<T>): Promise<T> {
    const client = await this.clientPromise();
    try {
      return await operation(client);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!STALE_CHANNEL_SIGNATURES.test(message)) throw error;
      this.reset();
      const rebuilt = await this.clientPromise();
      return operation(rebuilt);
    }
  }
}
