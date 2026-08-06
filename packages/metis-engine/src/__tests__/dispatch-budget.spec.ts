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
 * A node's retry policy runs INSIDE one activity, so the activity's budget has
 * to be able to hold it. Fixed at two minutes it could not: an http node at a
 * 30s timeout with retries: 4 spends 150s of dispatches inside a 120s budget,
 * Temporal times the activity out and retries the whole thing up to three
 * times, and the outside world sees the same request up to fifteen times -
 * several of them at once, because the timed-out dispatch was never told to
 * stop. `idempotencyKey` is opt-in, so most nodes have nothing to dedupe on.
 *
 * Two halves, tested apart: the budget arithmetic (pure, and the reason a
 * 150s policy no longer outruns its activity) and the abort (a hung dispatch
 * that has to hear about its own timeout, so the next attempt does not overlap
 * it). The budget is deliberately NOT proved through a real Temporal run: the
 * shortest honest one costs over two minutes of wall clock on every CI pass,
 * and the number under test is the one this computes.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapturingEventSink, FakeCredentialPort, NodeHandlerRegistry } from '@mindlynx/metis-ports';
import {
  DataGateway,
  SqliteAdapter,
  WorkflowStore,
  registerWorkflowTables,
} from '@mindlynx/metis-data-gateway';
import { createActivities } from '../activities/create-activities.js';
import {
  DISPATCH_BUDGET_MAX_MS,
  DISPATCH_BUDGET_MIN_MS,
  dispatchBudgetMs,
} from '../types.js';

const NODE = 'node-80aaaaaa-1111-4222-8333-444444444444';

describe('the dispatch activity budget follows the node policy', () => {
  it('is the two-minute floor when the node sets no policy', () => {
    expect(dispatchBudgetMs(undefined)).toBe(DISPATCH_BUDGET_MIN_MS);
    expect(dispatchBudgetMs({})).toBe(DISPATCH_BUDGET_MIN_MS);
  });

  it('covers the policy that used to outrun it: 30s timeout, retries 4', () => {
    // 5 attempts * 30s = 150s of dispatches. The old fixed 120s could not hold
    // it, so Temporal retried the activity while the fourth was still going.
    const budget = dispatchBudgetMs({ timeoutSeconds: 30, retries: 4 });
    expect(budget).toBeGreaterThan(150_000);
  });

  it('counts the backoffs, which a policy with no per-attempt timeout still spends', () => {
    // 4 attempts, 3 gaps of 60s: the handler is instant and the budget is not.
    expect(dispatchBudgetMs({ retries: 3, backoffSeconds: 60 })).toBeGreaterThan(180_000);
  });

  it('honours the same attempt bound the policy loop does', () => {
    // retries: 99 is capped at 10 attempts, so the budget is capped with it -
    // the two numbers have to come from the same rule or one of them is a lie.
    expect(dispatchBudgetMs({ timeoutSeconds: 1, retries: 99 })).toBe(
      dispatchBudgetMs({ timeoutSeconds: 1, retries: 9 }),
    );
  });

  it('never derives an activity that outlives the ceiling', () => {
    expect(dispatchBudgetMs({ timeoutSeconds: 86_400, retries: 9 })).toBe(DISPATCH_BUDGET_MAX_MS);
    expect(dispatchBudgetMs({ backoffSeconds: Number.MAX_SAFE_INTEGER, retries: 9 })).toBe(
      DISPATCH_BUDGET_MAX_MS,
    );
  });

  it('ignores a negative or fractional retry count rather than inverting the budget', () => {
    expect(dispatchBudgetMs({ timeoutSeconds: -5, retries: -3 })).toBe(DISPATCH_BUDGET_MIN_MS);
  });
});

describe('a dispatch that outran its policy timeout is told to stop', () => {
  it('aborts the losing handler so the next attempt does not overlap it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-abort-'));
    const gateway = new DataGateway(new SqliteAdapter(join(dir, 'abort.db')));
    registerWorkflowTables(gateway);
    const nodes = new NodeHandlerRegistry();
    const aborted: boolean[] = [];
    // Stands in for a live POST: it never answers, and it is the only thing
    // that can tell us whether anyone asked it to stop.
    nodes.registerNodeHandler(
      'hung',
      (ctx) =>
        new Promise((resolve) => {
          ctx.signal?.addEventListener('abort', () => {
            aborted.push(true);
            resolve({ status: 499, message: 'aborted' });
          });
        }),
    );
    const activities = createActivities({
      store: new WorkflowStore(gateway),
      events: new CapturingEventSink(),
      nodes,
      credentials: new FakeCredentialPort(),
    });
    const result = await activities.executeNode({
      tenantId: 't1',
      workflowId: 'wf-abort',
      executionId: 'exec-abort-1',
      node: { id: NODE, type: 'hung', config: {}, policy: { timeoutSeconds: 0.05, retries: 1 } },
      states: [],
      sequence: 1,
    });
    expect(result.outcome).toBe('failed');
    // Both attempts timed out, and both were told so - the second dispatch
    // never overlapped a first that was still in flight.
    expect(result.attempts).toBe(2);
    expect(aborted).toHaveLength(2);
  });
});
