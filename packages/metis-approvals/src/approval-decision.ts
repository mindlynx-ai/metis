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
 * What an approval step is, and what an answer to it means. Everything here
 * is pure: the handler brings the clock, the run and the graph.
 *
 * The single rule the rest of the file serves: a run must never pass an
 * approval that nobody made. So an unreadable answer, an unattributable one
 * and an expired one all resolve to something OTHER than approved, and the
 * approver is only ever the identity the server stamped on the signal.
 */
import { isParkExpiry } from '@mindlynx/metis-ports';

export type ApproverRole = 'admin' | 'editor';
export type ExpiryRule = 'reject' | 'escalate' | 'fail';

/** The signal name an approval answers to; the run's id makes it unique. */
export const APPROVAL_SIGNAL_PREFIX = 'approval:';
const URGENT_SUFFIX = ':urgent';

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_SLA_HOURS = 24;

export interface ApprovalConfig {
  title: string;
  summary: Record<string, unknown>;
  approverRole: ApproverRole;
  slaMs: number;
  onExpiry: ExpiryRule;
}

/** One label/value pair a reviewer needs to decide (already substituted). */
export interface ApprovalField {
  label: string;
  value: string;
}

/** What the queue shows: it rides the run's waiting log line. A type alias,
 *  not an interface, so it satisfies the park's `Record<string, unknown>`. */
export type ApprovalRequest = {
  kind: 'approval';
  title: string;
  fields: ApprovalField[];
  approverRole: ApproverRole;
  /** Raised a second time because the first SLA ran out. */
  escalated?: true;
  /** Why the last answer did not count (wrong role, unreadable decision). */
  refused?: string;
};

/** The audit line: who decided what, why, and when. */
export interface ApprovalRecord {
  decision: 'approved' | 'rejected';
  /** Absent when nobody decided: the SLA ran out. */
  approver?: string;
  approverRole?: string;
  reason?: string;
  at: string;
  expired?: true;
  escalated?: true;
}

export type DecisionOutcome =
  | { verdict: 'decided'; record: ApprovalRecord }
  /** Nothing was decided; raise it again (unauthorised, or unreadable). */
  | { verdict: 'refused'; refused: string }
  /** The SLA ran out and the step is set to escalate: raise it once more. */
  | { verdict: 'escalate' }
  /** The SLA ran out and the step is set to stop the run. */
  | { verdict: 'fail'; message: string };

const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2 };

/** True when the deciding session's role reaches the step's floor. */
export function roleAllows(floor: ApproverRole, role: unknown): boolean {
  const held = ROLE_RANK[String(role ?? '').toLowerCase()];
  return held !== undefined && held >= ROLE_RANK[floor]!;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  return value === undefined || value === null ? '' : JSON.stringify(value);
}

/**
 * Read a node's config. A malformed approval throws rather than parking:
 * a gate nobody can read is worse than a step that stops the run at once.
 */
export function readApprovalConfig(raw: Record<string, unknown>): ApprovalConfig {
  const title = asText(raw.title).trim();
  if (title === '') throw new Error('an approval step needs a title: say what is being approved');
  const role = String(raw.approverRole ?? 'admin').toLowerCase();
  if (role !== 'admin' && role !== 'editor') {
    throw new Error(`approverRole must be admin or editor, not "${role}"`);
  }
  const onExpiry = String(raw.onExpiry ?? 'reject').toLowerCase();
  if (onExpiry !== 'reject' && onExpiry !== 'escalate' && onExpiry !== 'fail') {
    throw new Error(`onExpiry must be reject, escalate or fail, not "${onExpiry}"`);
  }
  const hours = Number(raw.slaHours);
  const summary = raw.summary;
  return {
    title,
    summary: typeof summary === 'object' && summary !== null ? (summary as Record<string, unknown>) : {},
    approverRole: role,
    slaMs: (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SLA_HOURS) * HOUR_MS,
    onExpiry,
  };
}

/** The signal name for this node's park; urgent once it has escalated. */
export function approvalSignalType(nodeId: string, escalated = false): string {
  return `${APPROVAL_SIGNAL_PREFIX}${nodeId}${escalated ? URGENT_SUFFIX : ''}`;
}

/** True when the park that just expired was already the escalated one. */
export function isEscalatedSignal(signalType: unknown): boolean {
  return String(signalType ?? '').endsWith(URGENT_SUFFIX);
}

/** The request a reviewer sees, built from the substituted config. */
export function buildApprovalRequest(
  config: ApprovalConfig,
  extra: { escalated?: true; refused?: string } = {},
): ApprovalRequest {
  return {
    kind: 'approval',
    title: config.title,
    fields: Object.entries(config.summary).map(([label, value]) => ({ label, value: asText(value) })),
    approverRole: config.approverRole,
    ...extra,
  };
}

/** The expiry branch: never approved, and never silently either. */
function expiryOutcome(config: ApprovalConfig, params: unknown, at: string): DecisionOutcome {
  if (config.onExpiry === 'fail') {
    return { verdict: 'fail', message: `nobody decided "${config.title}" in time` };
  }
  const alreadyUrgent = isEscalatedSignal((params as { signalType?: unknown } | undefined)?.signalType);
  if (config.onExpiry === 'escalate' && !alreadyUrgent) return { verdict: 'escalate' };
  // Reject, and after an escalation that also went unanswered. Silence is not
  // consent: the only safe reading of "nobody looked" is no.
  return {
    verdict: 'decided',
    record: { decision: 'rejected', at, expired: true, ...(alreadyUrgent ? { escalated: true as const } : {}) },
  };
}

/**
 * Turn the params delivered to a parked approval into its outcome.
 * `signalledBy` / `signalledByRole` are stamped by the signal route from the
 * session: a decision that carries neither cannot be attributed to anyone,
 * so it decides nothing.
 */
export function resolveDecision(
  config: ApprovalConfig,
  params: unknown,
  at: string,
): DecisionOutcome {
  if (isParkExpiry(params)) return expiryOutcome(config, params, at);
  const answer = (params ?? {}) as Record<string, unknown>;
  const decision = String(answer.decision ?? '').toLowerCase();
  if (decision !== 'approved' && decision !== 'rejected') {
    return { verdict: 'refused', refused: 'That answer was not a decision, so nothing was recorded.' };
  }
  const approver = asText(answer.signalledBy).trim();
  const role = asText(answer.signalledByRole).trim();
  if (approver === '' || role === '') {
    return { verdict: 'refused', refused: 'That decision arrived without a signed-in approver.' };
  }
  if (!roleAllows(config.approverRole, role)) {
    return { verdict: 'refused', refused: `Deciding this needs the ${config.approverRole} role.` };
  }
  const reason = asText(answer.reason).trim();
  return {
    verdict: 'decided',
    record: {
      decision,
      approver,
      approverRole: role,
      at,
      ...(reason === '' ? {} : { reason }),
    },
  };
}

/**
 * Split the step's outgoing edges by the decision. Only an edge on the
 * matching handle runs: an unlabelled edge is not the approved path, so a
 * miswired graph stalls rather than paying an invoice nobody signed off.
 */
export function partitionByDecision(
  targets: { id: string; handle?: string }[],
  decision: 'approved' | 'rejected',
): { selectedSources: string[]; selectedTargetIds: string[]; orphanedTargetIds: string[] } {
  const selectedTargetIds: string[] = [];
  const orphanedTargetIds: string[] = [];
  for (const target of targets) {
    const bucket = target.handle === decision ? selectedTargetIds : orphanedTargetIds;
    if (!bucket.includes(target.id)) bucket.push(target.id);
  }
  return { selectedSources: [decision], selectedTargetIds, orphanedTargetIds };
}
