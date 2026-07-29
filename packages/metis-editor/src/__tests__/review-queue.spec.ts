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
import { describe, it, expect } from 'vitest';
import { mayDecide, reviewQueue } from '../runs/review-queue.js';
import { addableEntries, isLockedCapability } from '../builder/palette-entries.js';
import type { CatalogueEntry, TemporalExecution, WaitingOn } from '../api.js';

const run = (id: string, waitingOn?: WaitingOn, startTime = '2026-07-29T09:00:00.000Z'): TemporalExecution => ({
  workflowId: id,
  runId: `${id}-run`,
  type: 'helixWorkflow',
  status: 'running',
  startTime,
  workflowName: 'Refunds',
  runState: waitingOn ? 'waiting' : 'running',
  waitingOn,
});

const approval = (title: string, extra: Record<string, unknown> = {}): WaitingOn => ({
  signalType: 'approval:node-1',
  until: '2026-07-30T09:00:00.000Z',
  details: {
    kind: 'approval',
    title,
    fields: [{ label: 'Amount', value: '4182.50' }],
    approverRole: 'admin',
    ...extra,
  },
});

describe('reviewQueue', () => {
  it('shows a parked approval with the values a person needs to decide', () => {
    const [item] = reviewQueue([run('exec-1', approval('Refund order 4182'))]);
    expect(item).toMatchObject({
      executionId: 'exec-1',
      workflowName: 'Refunds',
      signalType: 'approval:node-1',
      title: 'Refund order 4182',
      fields: [{ label: 'Amount', value: '4182.50' }],
      approverRole: 'admin',
      escalated: false,
      until: '2026-07-30T09:00:00.000Z',
    });
  });

  it('ignores runs parked on anything else, and runs that are working', () => {
    const rows = [
      run('exec-1', { signalType: 'adobesign.signed' }),
      run('exec-2', { until: '2026-07-30T09:00:00.000Z' }),
      run('exec-3'),
    ];
    expect(reviewQueue(rows)).toEqual([]);
  });

  it('drops an approval with no signal name: there is no way to answer it', () => {
    const orphan = approval('Refund');
    delete orphan.signalType;
    expect(reviewQueue([run('exec-1', orphan)])).toEqual([]);
  });

  it('puts escalated approvals first, then the oldest wait', () => {
    const rows = [
      run('recent', approval('Recent'), '2026-07-29T10:00:00.000Z'),
      run('old', approval('Old'), '2026-07-29T08:00:00.000Z'),
      run('urgent', approval('Urgent', { escalated: true }), '2026-07-29T11:00:00.000Z'),
    ];
    expect(reviewQueue(rows).map((item) => item.executionId)).toEqual(['urgent', 'old', 'recent']);
  });

  it('carries why a previous answer did not count', () => {
    const [item] = reviewQueue([run('exec-1', approval('Refund', { refused: 'Needs the admin role.' }))]);
    expect(item?.refused).toBe('Needs the admin role.');
  });
});

describe('mayDecide', () => {
  const [adminOnly] = reviewQueue([run('exec-1', approval('Refund'))]);
  const [editorOk] = reviewQueue([run('exec-2', approval('Refund', { approverRole: 'editor' }))]);

  it('holds an editor to an admin-only approval', () => {
    expect(mayDecide(adminOnly!, 'admin')).toBe(true);
    expect(mayDecide(adminOnly!, 'editor')).toBe(false);
    expect(mayDecide(editorOk!, 'editor')).toBe(true);
  });

  it('never lets a viewer, or an unknown session, decide', () => {
    expect(mayDecide(editorOk!, 'viewer')).toBe(false);
    expect(mayDecide(editorOk!, undefined)).toBe(false);
  });
});

describe('the palette and entitled steps', () => {
  const entry = (over: Partial<CatalogueEntry>): CatalogueEntry =>
    ({ type: 'x', category: 'logic', tier: 'open', handler_status: 'ready', ...over }) as CatalogueEntry;
  // Hypothetical on purpose: no shipped entry is entitled AND local today (the
  // sign-off gate was, until it became part of the product). The rule is what
  // is under test, so it is exercised on the shape rather than on whichever
  // node happens to have it this month.
  const entitledLocal = entry({ type: 'future', entitlement: 'cap.later', execution: 'local' });
  const cloudEntry = entry({ type: 'data', entitlement: 'cap.data', execution: 'both' });
  const openEntry = entry({ type: 'code' });
  const approvalEntry = entry({ type: 'approval', execution: 'local' });

  it('an entitled local step is locked without the entitlement, addable with it', () => {
    expect(isLockedCapability(entitledLocal, [])).toBe(true);
    expect(isLockedCapability(entitledLocal, ['cap.later'])).toBe(false);
  });

  it('a cloud step stays addable: it has a local backend either way', () => {
    expect(isLockedCapability(cloudEntry, [])).toBe(false);
  });

  it('the sign-off gate is addable on an instance that owns nothing', () => {
    // The regression this exists to catch: an entitlement back on the approval
    // entry would make the palette hide it on every instance in existence,
    // including one whose runtime can execute it perfectly well.
    expect(isLockedCapability(approvalEntry, [])).toBe(false);
    expect(addableEntries([approvalEntry], []).map((item) => item.type)).toEqual(['approval']);
  });

  it('the picker offers what this build can run, and never what it cannot', () => {
    const owned = addableEntries([openEntry, cloudEntry, entitledLocal], []).map((item) => item.type);
    expect(owned).toEqual(['code', 'data']);
    const entitled = addableEntries([openEntry, cloudEntry, entitledLocal], ['cap.later']);
    expect(entitled.map((item) => item.type)).toContain('future');
  });
});
