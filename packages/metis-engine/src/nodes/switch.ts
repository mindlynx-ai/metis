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
 * Switch-node condition evaluator, ported from the origin
 * engine's utilities/switch.ts, which already carries the three
 * verified fixes relative to the upstream worker:
 *
 *   - isIn: membership test without the accidental assignment
 *   - isNotIn: same fix, negated
 *   - default: unknown operators return false explicitly
 *
 * Pure module: safe for workflow and activity contexts alike. Errors
 * during evaluation select source-default, preserving origin behaviour.
 */

export interface SwitchCondition {
  property: unknown;
  checkValue: unknown;
  checkOperator: string;
}

export interface SwitchConfig {
  id: string;
  conditions: SwitchCondition[];
}

export interface TargetRef {
  id: string;
  handle?: string;
}

function resolveProperty(rawProperty: unknown, inputData: unknown): unknown {
  if (typeof rawProperty !== 'string') return rawProperty;
  let key: string | null = null;
  if (rawProperty.startsWith('ctx.input.')) {
    key = rawProperty.slice('ctx.input.'.length);
  } else if (rawProperty.startsWith('input.')) {
    key = rawProperty.slice('input.'.length);
  }
  if (key === null) return rawProperty;
  let cursor: unknown = inputData;
  for (const part of key.split('.')) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function processOperation(value1: unknown, value2: unknown, operator: string): boolean {
  try {
    switch (operator) {
      case '===':
        return value1 === value2;
      case '!==':
        return value1 !== value2;
      case '<':
        return (value1 as number) < (value2 as number);
      case '>':
        return (value1 as number) > (value2 as number);
      case '<=':
        return (value1 as number) <= (value2 as number);
      case '>=':
        return (value1 as number) >= (value2 as number);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** Evaluate one (value, checkValue, operator) tuple across the fifteen operators. */
export function checkConditionResult(
  value: unknown,
  checkValue: unknown,
  operator: string,
): boolean {
  const operatorAliases: Record<string, string> = { '=': '===', '!=': '!==' };
  const op = operatorAliases[operator] ?? operator;

  switch (op) {
    case '===':
    case '!==':
    case '<':
    case '>':
    case '<=':
    case '>=':
      return processOperation(value, Number(checkValue) || checkValue, op);
    case 'contains':
      return (value as string | unknown[]).includes(checkValue as never);
    case 'isTrue':
      return value === true;
    case 'isFalse':
      return value === false;
    case 'isNull':
      return value === null || value === undefined;
    case 'isNotNull':
      return value !== null && value !== undefined;
    case 'isEmpty':
      return value === '';
    case 'isIn':
      return (checkValue as string[]).includes(value as string);
    case 'isNotIn':
      return !(checkValue as string[]).includes(value as string);
    case 'isBetween': {
      const bounds = checkValue as unknown[];
      const upper = Math.max(Number(bounds[0]), Number(bounds[1]));
      const lower = Math.min(Number(bounds[0]), Number(bounds[1]));
      return processOperation(value, lower, '>=') && processOperation(value, upper, '<=');
    }
    default:
      return false;
  }
}

/**
 * Evaluate the branch configurations in order; the first branch whose
 * conditions all hold selects `source-<id>`, otherwise source-default.
 * Any thrown error also selects source-default (origin behaviour).
 */
export function checkSwitchCondition(
  switchOptions: SwitchConfig[] | undefined,
  inputData?: unknown,
): string[] {
  try {
    if (!switchOptions) return ['source-default'];
    for (const config of switchOptions) {
      const allHold = config.conditions.every((condition) =>
        checkConditionResult(
          resolveProperty(condition.property, inputData),
          condition.checkValue,
          condition.checkOperator,
        ),
      );
      if (allHold) return [`source-${config.id}`];
    }
    return ['source-default'];
  } catch {
    return ['source-default'];
  }
}

/** Split a switch node's targets into selected and orphaned sets by handle. */
export function partitionTargets(
  targets: TargetRef[],
  selectedSources: string[],
): { selectedTargetIds: string[]; orphanedTargetIds: string[] } {
  const selectedSet = new Set(selectedSources);
  const selectedTargetIds: string[] = [];
  const orphanedTargetIds: string[] = [];
  for (const target of targets) {
    const handle = target.handle ?? 'source-default';
    if (selectedSet.has(handle)) {
      if (!selectedTargetIds.includes(target.id)) selectedTargetIds.push(target.id);
    } else if (!orphanedTargetIds.includes(target.id)) {
      orphanedTargetIds.push(target.id);
    }
  }
  return { selectedTargetIds, orphanedTargetIds };
}
