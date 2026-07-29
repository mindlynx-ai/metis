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
 * The review queue, derived from the runs the server already reports. A
 * parked run says what it is waiting for on its whereabouts, and a step that
 * parks for a person puts the request there too, so the queue needs no
 * endpoint of its own and no second store to fall out of step with the runs.
 *
 * The shape of that request is duplicated here on purpose: the paid pack
 * that writes it must never be importable from the open editor, so this
 * side reads it defensively and shows only what it recognises.
 */
import type { TemporalExecution, WaitingOn } from '../api.js';

/** Marks a park as one a person answers. Matched, never imported. */
const APPROVAL_KIND = 'approval';

export interface ReviewField {
  label: string;
  value: string;
}

export interface ReviewItem {
  executionId: string;
  workflowName: string;
  /** The signal the decision is posted back on (from the run, not guessed). */
  signalType: string;
  title: string;
  fields: ReviewField[];
  /** The lowest role allowed to decide, when the step said so. */
  approverRole?: string;
  /** Raised again because the first deadline passed. */
  escalated: boolean;
  /** Why a previous answer did not count. */
  refused?: string;
  /** When the SLA runs out. */
  until?: string;
  startTime?: string;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  return value === undefined || value === null ? '' : JSON.stringify(value);
}

function readFields(raw: unknown): ReviewField[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => entry as { label?: unknown; value?: unknown })
    .filter((entry) => typeof entry?.label === 'string')
    .map((entry) => ({ label: entry.label as string, value: asText(entry.value) }));
}

/** The approval a parked run is waiting on, or undefined for other parks. */
function reviewOf(row: TemporalExecution): ReviewItem | undefined {
  const waiting: WaitingOn | undefined = row.runState === 'waiting' ? row.waitingOn : undefined;
  const details = waiting?.details;
  if (!details || details.kind !== APPROVAL_KIND) return undefined;
  // Without the signal name there is no way to answer it, so it is not
  // actionable and does not belong in a queue of things to action.
  if (!waiting?.signalType) return undefined;
  return {
    executionId: row.workflowId,
    workflowName: row.workflowName ?? row.workflowId,
    signalType: waiting.signalType,
    title: asText(details.title) || 'Approval',
    fields: readFields(details.fields),
    approverRole: typeof details.approverRole === 'string' ? details.approverRole : undefined,
    escalated: details.escalated === true,
    refused: typeof details.refused === 'string' ? details.refused : undefined,
    until: waiting.until,
    startTime: row.startTime,
  };
}

/** Every parked approval in the run list, the ones that have escalated first. */
export function reviewQueue(rows: TemporalExecution[]): ReviewItem[] {
  const items = rows.map(reviewOf).filter((item): item is ReviewItem => item !== undefined);
  return items.sort((a, b) => {
    if (a.escalated !== b.escalated) return a.escalated ? -1 : 1;
    return (a.startTime ?? '').localeCompare(b.startTime ?? '');
  });
}

/** True when this session's role may decide the item (the endpoint gates
 *  viewers regardless; this stops the buttons promising what will fail). */
export function mayDecide(item: ReviewItem, role: string | undefined): boolean {
  const rank: Record<string, number> = { viewer: 0, editor: 1, admin: 2 };
  const held = rank[String(role ?? '').toLowerCase()];
  const floor = rank[String(item.approverRole ?? 'admin').toLowerCase()] ?? rank.admin!;
  return held !== undefined && held > 0 && held >= floor;
}
