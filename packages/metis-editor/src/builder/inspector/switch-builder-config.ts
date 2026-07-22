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
 * Pure logic for the switch node's branch editor, separated from the React
 * component. Mirrors the Helix switch inspector: the full 15-operator set the
 * engine supports, and the checkValue SHAPE each operator needs - a plain value,
 * a two-element [from,to] for `isBetween`, a string[] for `isIn`/`isNotIn`, or
 * nothing for the unary operators. The editor holds values as strings; this maps
 * them to/from the engine config shape. No React, so it is trivially tested.
 */

export type ValueMode = 'single' | 'list' | 'between' | 'none';

export interface OperatorDef {
  value: string;
  label: string;
  mode: ValueMode;
}

/** The switch engine's 15 operators (nodes/switch.ts checkConditionResult), with
 *  the glyph labels Helix shows. `=`/`!=` normalise to `===`/`!==` in the engine. */
export const OPERATORS: OperatorDef[] = [
  { value: '===', label: '= equals', mode: 'single' },
  { value: '!==', label: '≠ not equals', mode: 'single' },
  { value: '>', label: '> greater than', mode: 'single' },
  { value: '<', label: '< less than', mode: 'single' },
  { value: '>=', label: '≥ greater or equal', mode: 'single' },
  { value: '<=', label: '≤ less or equal', mode: 'single' },
  { value: 'contains', label: 'contains', mode: 'single' },
  { value: 'isBetween', label: 'is between', mode: 'between' },
  { value: 'isIn', label: 'is in list', mode: 'list' },
  { value: 'isNotIn', label: 'not in list', mode: 'list' },
  { value: 'isTrue', label: 'is true', mode: 'none' },
  { value: 'isFalse', label: 'is false', mode: 'none' },
  { value: 'isNull', label: 'is null', mode: 'none' },
  { value: 'isNotNull', label: 'is not null', mode: 'none' },
  { value: 'isEmpty', label: 'is empty', mode: 'none' },
];

export function modeOf(operator: string): ValueMode {
  return OPERATORS.find((entry) => entry.value === operator)?.mode ?? 'single';
}

/** Editor-side condition state: all strings (value2 only used by `between`). */
export interface Condition {
  property: string;
  checkOperator: string;
  value: string;
  value2: string;
}
export interface Branch {
  id: string;
  name: string;
  alias: string;
  conditions: Condition[];
}

export const blankCondition = (): Condition => ({ property: '', checkOperator: '===', value: '', value2: '' });

/** The engine checkValue for a condition, by operator mode: a list -> string[],
 *  between -> [from,to], unary -> undefined (omitted), else the raw string. */
export function checkValueOf(condition: Condition): unknown {
  switch (modeOf(condition.checkOperator)) {
    case 'none':
      return undefined;
    case 'list':
      return condition.value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
    case 'between':
      return [condition.value, condition.value2];
    default:
      return condition.value;
  }
}

/** The next stable branch id (branch-N), independent of the name so renaming a
 *  branch never breaks the edge drawn from its `source-<id>` handle. */
export function nextBranchId(branches: { id?: string }[]): string {
  const max = branches.reduce((highest, branch) => {
    const matched = /^branch-(\d+)$/.exec(branch.id ?? '')?.[1];
    return matched ? Math.max(highest, Number(matched)) : highest;
  }, 0);
  return `branch-${max + 1}`;
}

/** The switchOptions config the engine runs, from the editor branches. Conditions
 *  with no property are dropped so a branch never routes on nothing. */
export function branchesToOptions(branches: Branch[]): Record<string, unknown>[] {
  return branches.map((branch) => ({
    id: branch.id,
    name: branch.name,
    ...(branch.alias.trim() !== '' ? { alias: branch.alias } : {}),
    conditions: branch.conditions
      .filter((condition) => condition.property.trim() !== '')
      .map((condition) => {
        const checkValue = checkValueOf(condition);
        return {
          property: condition.property,
          checkOperator: condition.checkOperator,
          ...(checkValue === undefined ? {} : { checkValue }),
        };
      }),
  }));
}

function seedCondition(raw: Record<string, unknown>): Condition {
  const checkOperator = String(raw?.checkOperator ?? '===');
  const mode = modeOf(checkOperator);
  const checkValue = raw?.checkValue;
  if (mode === 'between' && Array.isArray(checkValue)) {
    return { property: String(raw?.property ?? ''), checkOperator, value: String(checkValue[0] ?? ''), value2: String(checkValue[1] ?? '') };
  }
  if (mode === 'list' && Array.isArray(checkValue)) {
    return { property: String(raw?.property ?? ''), checkOperator, value: checkValue.join(', '), value2: '' };
  }
  return {
    property: String(raw?.property ?? ''),
    checkOperator,
    value: checkValue === undefined || checkValue === null ? '' : String(checkValue),
    value2: '',
  };
}

/** Editor branches from a stored switchOptions config (the reverse of above). */
export function seedBranches(config: Record<string, unknown>): Branch[] {
  const options = Array.isArray(config.switchOptions) ? config.switchOptions : [];
  return (options as Record<string, unknown>[]).map((option, index) => ({
    id: String(option?.id ?? `branch-${index + 1}`),
    name: String(option?.name ?? ''),
    alias: String(option?.alias ?? ''),
    conditions: (Array.isArray(option?.conditions) ? (option.conditions as Record<string, unknown>[]) : []).map(
      seedCondition,
    ),
  }));
}
