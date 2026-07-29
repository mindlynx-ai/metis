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
import { signalPark, type NodeHandlerContext } from '@mindlynx/metis-ports';
import {
  approvalSignalType,
  buildApprovalRequest,
  partitionByDecision,
  readApprovalConfig,
  resolveDecision,
  roleAllows,
} from '../approval-decision.js';
import { createApprovalNodeHandler } from '../approval-node.js';

const AT = '2026-07-29T09:00:00.000Z';
const NODE = 'node-91aaaaaa-1111-4222-8333-444444444444';

const config = (raw: Record<string, unknown> = {}) =>
  readApprovalConfig({ title: 'Refund order 4182', ...raw });

const context = (
  overrides: Partial<NodeHandlerContext> & { config?: Record<string, unknown> } = {},
): NodeHandlerContext =>
  ({
    nodeRef: {
      id: NODE,
      type: 'approval',
      config: { title: 'Refund order 4182', ...(overrides.config ?? {}) },
      signalParams: overrides.nodeRef?.signalParams,
    },
    tenantId: 't1',
    executionId: 'exec-1',
    workflowId: 'wf-1',
    workflowState: { states: [] },
    targets: overrides.targets,
  }) as NodeHandlerContext;

describe('approval config', () => {
  it('defaults to the admin role, a 24 hour SLA and rejection on expiry', () => {
    const parsed = config();
    expect(parsed.approverRole).toBe('admin');
    expect(parsed.slaMs).toBe(24 * 60 * 60 * 1000);
    expect(parsed.onExpiry).toBe('reject');
  });

  it('refuses a step with nothing to approve, and unknown rules', () => {
    expect(() => readApprovalConfig({})).toThrow(/needs a title/i);
    expect(() => config({ approverRole: 'viewer' })).toThrow(/admin or editor/i);
    expect(() => config({ onExpiry: 'approve' })).toThrow(/reject, escalate or fail/i);
  });

  it('shows the substituted summary as the reviewer sees it', () => {
    const request = buildApprovalRequest(config({ summary: { Amount: 4182.5, Customer: 'Ada' } }));
    expect(request.fields).toEqual([
      { label: 'Amount', value: '4182.5' },
      { label: 'Customer', value: 'Ada' },
    ]);
  });
});

describe('who may decide', () => {
  it('an admin clears both floors; an editor clears only its own', () => {
    expect(roleAllows('admin', 'admin')).toBe(true);
    expect(roleAllows('editor', 'admin')).toBe(true);
    expect(roleAllows('admin', 'editor')).toBe(false);
    expect(roleAllows('editor', 'editor')).toBe(true);
  });

  it('a viewer can never decide, whatever the step asks for', () => {
    expect(roleAllows('editor', 'viewer')).toBe(false);
    expect(roleAllows('admin', 'viewer')).toBe(false);
  });

  it('a decision from too low a role decides nothing and is raised again', () => {
    const outcome = resolveDecision(config(), signalledBy('sam', 'editor', 'approved'), AT);
    expect(outcome).toEqual({ verdict: 'refused', refused: 'Deciding this needs the admin role.' });
  });

  it('a decision nobody signed cannot be attributed, so it decides nothing', () => {
    const outcome = resolveDecision(config(), { decision: 'approved', signalledBy: 'jeremy' }, AT);
    expect(outcome).toMatchObject({ verdict: 'refused' });
  });
});

const signalledBy = (userId: string, role: string, decision: string, reason?: string) => ({
  decision,
  reason,
  signalledBy: userId,
  signalledByRole: role,
});

describe('a decision becomes the audit record', () => {
  it('records who decided, what, why and when', () => {
    const outcome = resolveDecision(
      config(),
      signalledBy('jeremy', 'admin', 'approved', 'checked the invoice'),
      AT,
    );
    expect(outcome).toEqual({
      verdict: 'decided',
      record: {
        decision: 'approved',
        approver: 'jeremy',
        approverRole: 'admin',
        reason: 'checked the invoice',
        at: AT,
      },
    });
  });

  it('an answer that is not a decision records nothing', () => {
    expect(resolveDecision(config(), { signalledBy: 'jeremy', signalledByRole: 'admin' }, AT)).toMatchObject({
      verdict: 'refused',
    });
  });
});

describe('the SLA running out', () => {
  it('rejects by default: nobody decided, and silence is not consent', () => {
    const outcome = resolveDecision(config(), { expired: true, signalType: 'approval:n1' }, AT);
    expect(outcome).toEqual({
      verdict: 'decided',
      record: { decision: 'rejected', at: AT, expired: true },
    });
    // Nobody approved it, so the record names nobody.
    expect(outcome).not.toHaveProperty('record.approver');
  });

  it('escalates once, then rejects when the urgent deadline also passes', () => {
    const escalating = config({ onExpiry: 'escalate' });
    expect(resolveDecision(escalating, { expired: true, signalType: approvalSignalType('n1') }, AT)).toEqual({
      verdict: 'escalate',
    });
    const second = resolveDecision(
      escalating,
      { expired: true, signalType: approvalSignalType('n1', true) },
      AT,
    );
    expect(second).toEqual({
      verdict: 'decided',
      record: { decision: 'rejected', at: AT, expired: true, escalated: true },
    });
  });

  it('stops the run when the step says so', () => {
    const outcome = resolveDecision(config({ onExpiry: 'fail' }), { expired: true }, AT);
    expect(outcome).toMatchObject({ verdict: 'fail' });
  });
});

describe('the branch a decision takes', () => {
  const targets = [
    { id: 'pay', handle: 'approved' },
    { id: 'tell-them-no', handle: 'rejected' },
    { id: 'legacy-wire', handle: undefined },
  ];

  it('runs only the matching handle', () => {
    expect(partitionByDecision(targets, 'approved')).toEqual({
      selectedSources: ['approved'],
      selectedTargetIds: ['pay'],
      orphanedTargetIds: ['tell-them-no', 'legacy-wire'],
    });
  });

  it('never treats an unlabelled edge as the approved path', () => {
    const rejected = partitionByDecision(targets, 'rejected');
    expect(rejected.selectedTargetIds).toEqual(['tell-them-no']);
    expect(rejected.orphanedTargetIds).toContain('legacy-wire');
  });
});

describe('the handler', () => {
  it('parks on its own signal with the SLA and the request a reviewer reads', async () => {
    const result = await createApprovalNodeHandler()(
      context({ config: { summary: { Amount: '99.00' }, slaHours: 2 } }),
    );
    const park = signalPark(result);
    expect(park?.signalType).toBe(approvalSignalType(NODE));
    expect(park?.timeoutMs).toBe(2 * 60 * 60 * 1000);
    expect(park?.details).toMatchObject({
      kind: 'approval',
      title: 'Refund order 4182',
      approverRole: 'admin',
      fields: [{ label: 'Amount', value: '99.00' }],
    });
  });

  it('completes with the audit record and the branch, on the answer', async () => {
    const ctx = context({ targets: [{ id: 'pay', handle: 'approved' }] });
    ctx.nodeRef.signalParams = signalledBy('jeremy', 'admin', 'approved', 'fine');
    const result = await createApprovalNodeHandler()(ctx);
    expect(result.status).toBe(200);
    expect(result.nodeData?.data).toMatchObject({
      decision: 'approved',
      approver: 'jeremy',
      approverRole: 'admin',
      reason: 'fine',
      selectedTargetIds: ['pay'],
    });
    expect(String((result.nodeData?.data as { at: string }).at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('parks again when the answer decided nothing, saying why', async () => {
    const ctx = context();
    ctx.nodeRef.signalParams = signalledBy('sam', 'editor', 'approved');
    const park = signalPark(await createApprovalNodeHandler()(ctx));
    expect(park?.details).toMatchObject({ refused: 'Deciding this needs the admin role.' });
  });

  it('fails the node when a step with no title reaches the engine', async () => {
    const ctx = context();
    ctx.nodeRef.config = {};
    await expect(createApprovalNodeHandler()(ctx)).rejects.toThrow(/needs a title/i);
  });
});
