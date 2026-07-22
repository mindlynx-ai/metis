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
 * Parameter substitution for node config.
 *
 * Ported from the origin engine with deliberate deltas for the open
 * build:
 *
 *   - Secrets are NOT resolved here. `{{secrets.<uuid>}}` tokens pass
 *     through the engine untouched and are substituted only at the
 *     CredentialPort boundary at dispatch time, so secret material never
 *     enters engine memory or logs.
 *   - The `{{env.<NAME>}}` and `{{pathMapping/headerMapping.*}}` families
 *     are not ported: nothing in the open runtime populates them.
 *   - Node state always arrives inline on the workflow state (the origin's
 *     database fallback is not ported).
 *
 * Everything else, including the regex literals, the resolution order
 * (node references, then functions), the double-escape behaviour and
 * the switch-node `"property"` special case, follows the origin.
 *
 * The editor's variable picker emits the canonical `{{node-<uuid>.data.<key>}}`
 * form, which resolves against a node's seeded/produced state `{status, data}`.
 * A trigger node is seeded `{status:200, data:<seed>}` where <seed> differs by
 * trigger type, so downstream references differ accordingly:
 *   - apiconfig      seeds the request body directly -> `{{node-<id>.data.<key>}}`
 *   - webhookconfig  seeds the envelope `{...,body}`  -> `{{node-<id>.data.body.<key>}}`
 * The legacy naked `{{node-<id>.<key>}}` form resolves too (via legacyStateData),
 * so both the picker output and the older io-panels chips work. See the
 * "picker reference contract" tests in state.spec.ts.
 */
import { randomUUID } from 'node:crypto';

export interface NodeConfigParam {
  type: 'node' | 'secret' | 'function';
  value: string;
}

export interface WorkflowStateItem {
  states: {
    nodeId: string;
    stateId: string;
    stateData?: { status: number; data: unknown };
  }[];
}

const UUID_BODY = '[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}';

/** Walk one dotted path; segment keys never contain dots (uuids use hyphens). */
function valueAt(obj: unknown, dottedPath: string): unknown {
  let cursor: unknown = obj;
  for (const key of dottedPath.split('.')) {
    if (cursor === undefined || cursor === null || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function escapeString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function escapeJson(value: unknown): string {
  return JSON.stringify(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Find all config parameters embedded in a node configuration. Regex
 * literals match the origin engine; the env
 * family is deliberately not detected.
 */
export function findNodeConfigParams(nodeConfig: unknown): NodeConfigParam[] {
  const configData = JSON.stringify(nodeConfig);
  const result: NodeConfigParam[] = [];
  const push = (type: NodeConfigParam['type'], value: string) => {
    if (!result.some((entry) => entry.type === type && entry.value === value)) {
      result.push({ type, value });
    }
  };

  for (const match of configData.matchAll(new RegExp(`node-${UUID_BODY}\\.[.a-z0-9_-]*`, 'gi'))) {
    push('node', `{{${match[0]}}}`);
  }
  for (const match of configData.matchAll(new RegExp(`"node-${UUID_BODY}"`, 'gi'))) {
    push('node', `{{${match[0].replaceAll('"', '')}}}`);
  }
  for (const match of configData.matchAll(new RegExp(`{{secrets\\.${UUID_BODY}}}`, 'gi'))) {
    push('secret', match[0]);
  }
  for (const match of configData.matchAll(/{{(?!node-)[a-z]*\(\)}}/gi)) {
    push('function', match[0]);
  }
  return result;
}

function getParamNodes(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (value.startsWith('{{node-')) {
      const dotIndex = value.indexOf('.');
      const nodeId = (dotIndex >= 0 ? value.substring(0, dotIndex) : value.slice(0, -2)).replace(
        '{{',
        '',
      );
      if (!result.includes(nodeId)) result.push(nodeId);
    }
  }
  return result;
}

function loadNodeState(
  nodeId: string,
  workflowState: WorkflowStateItem,
): { nodeId: string; status: number; nodeData: unknown } | undefined {
  const items = workflowState.states.filter((entry) => entry.nodeId === nodeId);
  const first = items[0];
  if (!first?.stateData) return undefined;
  if (items.length === 1) {
    return { nodeId, status: first.stateData.status, nodeData: first.stateData.data };
  }
  return {
    nodeId: first.nodeId,
    status: first.stateData.status,
    nodeData: items.map((entry) => entry.stateData?.data),
  };
}

function substituteNodeParam(
  configCopy: string,
  paramToken: string,
  stateData: Record<string, { status: number; data: unknown }>,
  legacyStateData: Record<string, unknown>,
): string {
  const param = paramToken.replace('{{', '').replace('}}', '');
  let paramValue = valueAt(stateData, param);
  if (paramValue === undefined) paramValue = valueAt(legacyStateData, param);
  if (paramValue === undefined) return configCopy;

  const stringValue =
    typeof paramValue === 'string' ? escapeString(paramValue) : escapeJson(paramValue);
  let next = configCopy.replaceAll(paramToken, stringValue);
  const propertyReplacement = typeof paramValue === 'string' ? `"${stringValue}"` : stringValue;
  next = next.replaceAll(`"property":"${param}"`, `"property":${propertyReplacement}`);
  return next;
}

function substituteFunctions(configCopy: string, tokens: string[], executionId: string, tenantId: string): string {
  let next = configCopy;
  for (const token of tokens) {
    const func = token.replace('{{', '').replace('}}', '');
    switch (func) {
      case 'uuid()':
        while (next.includes(token)) next = next.replace(token, randomUUID());
        break;
      case 'now()':
        next = next.replaceAll(token, new Date().toISOString());
        break;
      case 'time()':
        next = next.replaceAll(token, Date.now().toString());
        break;
      case 'random()':
        // A non-security affordance for workflow authors (correlation
        // ids, cache busters); cryptographic strength is not a goal.
        while (next.includes(token)) {
          // eslint-disable-next-line sonarjs/pseudo-random
          next = next.replace(token, Math.floor(Math.random() * 100).toString());
        }
        break;
      case 'workflowId()':
        // The origin substitutes the execution id here: the Temporal
        // workflow id IS the execution id, so this is correct in context.
        next = next.replaceAll(token, executionId);
        break;
      case 'tenantId()':
        next = next.replaceAll(token, tenantId);
        break;
      default:
        break;
    }
  }
  return next;
}

/**
 * Replace config parameters with node state data, then built-in
 * functions, in that fixed order. Secret tokens pass through untouched
 * (see the file header). Returns the original config object when
 * nothing needs resolving.
 */
export function replaceConfigStateData(
  executionId: string,
  tenantId: string,
  nodeConfig: unknown,
  workflowState: WorkflowStateItem,
): unknown {
  const configParams = findNodeConfigParams(nodeConfig);
  const actionable = configParams.filter((entry) => entry.type !== 'secret');
  if (actionable.length === 0) {
    return nodeConfig;
  }

  let configCopy = JSON.stringify(nodeConfig);

  const nodeParams = configParams.filter((entry) => entry.type === 'node');
  if (nodeParams.length > 0) {
    const nodeIds = getParamNodes(nodeParams.map((entry) => entry.value));
    const stateData: Record<string, { status: number; data: unknown }> = {};
    const legacyStateData: Record<string, unknown> = {};
    for (const nodeId of nodeIds) {
      const nodeState = loadNodeState(nodeId, workflowState);
      if (!nodeState) continue;
      stateData[nodeState.nodeId] = { status: nodeState.status, data: nodeState.nodeData };
      legacyStateData[nodeState.nodeId] = nodeState.nodeData;
    }
    for (const param of nodeParams) {
      configCopy = substituteNodeParam(configCopy, param.value, stateData, legacyStateData);
    }
  }

  configCopy = substituteFunctions(
    configCopy,
    configParams.filter((entry) => entry.type === 'function').map((entry) => entry.value),
    executionId,
    tenantId,
  );

  return JSON.parse(configCopy);
}
