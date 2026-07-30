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
 * The part of an activity that is about running inside one: what the ambient
 * Temporal context can be asked (am I alive, have I been cancelled, which
 * attempt is this), and how a failure a retry cannot fix is raised so Temporal
 * does not come back for another go.
 *
 * Every reader is guarded, because these same activity functions are called
 * directly from unit tests with no activity context around them.
 */
import { ApplicationFailure, Context } from '@temporalio/activity';
import { resolveSecretTokens, type CredentialPort } from '@mindlynx/metis-ports';

/** Heartbeat when running inside a Temporal activity; no-op in unit tests. */
export function maybeHeartbeat(): void {
  try {
    Context.current().heartbeat();
  } catch {
    /* outside an activity context */
  }
}

/** A poll pause that aborts promptly when the activity is cancelled. */
export async function pollPause(ms: number): Promise<void> {
  let cancelled: Promise<never> | undefined;
  try {
    cancelled = Context.current().cancelled;
  } catch {
    /* outside an activity context */
  }
  const pause = new Promise<void>((resolve) => setTimeout(resolve, ms));
  await (cancelled ? Promise.race([pause, cancelled]) : pause);
}

/**
 * Which attempt of this activity we are on (1 outside an activity context).
 * Read here rather than passed in from the workflow: the workflow cannot know,
 * because a retry re-runs the SAME activity call with the SAME arguments. It
 * travels onto every log row so a run that dispatched a node twice says so,
 * instead of the second attempt overwriting the first one's line.
 */
export function activityAttempt(): number {
  try {
    return Context.current().info.attempt;
  } catch {
    return 1; /* outside an activity context */
  }
}

/**
 * Resolve `{{secrets.*}}` at the credential boundary, or refuse the node.
 *
 * A name that is not in the vault reads the same on the third attempt as on the
 * first, and the failure used to escape as a plain error, which Temporal
 * retries: under the default (unlimited) policy that was a node spinning on a
 * typo. Raised non-retryably, and named in ENGINE_ACTIVITY_RETRY so it holds
 * whichever activity resolves the secret.
 */
export async function resolveOrRefuse(
  config: unknown,
  tenantId: string,
  credentials: CredentialPort,
): Promise<unknown> {
  try {
    return await resolveSecretTokens(config, tenantId, credentials);
  } catch (error) {
    throw ApplicationFailure.nonRetryable(
      error instanceof Error ? error.message : String(error),
      'CredentialResolution',
    );
  }
}
