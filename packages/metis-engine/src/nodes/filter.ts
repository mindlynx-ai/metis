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
 * The filter node's element gate (n8n-gap Filter): split an array's ELEMENTS
 * into kept/discarded by conditions - the same 15-operator vocabulary as the
 * switch (checkConditionResult), applied per element via a dot-path `field`.
 * All conditions must hold (AND). Pure, workflow-free.
 */
import { checkConditionResult } from './switch.js';

export interface FilterCondition {
  /** Dot-path into each element, e.g. "status" or "customer.tier". Empty
   *  means the element itself. */
  field?: string;
  checkOperator: string;
  checkValue?: unknown;
}

function fieldValue(element: unknown, field: string | undefined): unknown {
  if (field === undefined || field.trim() === '') return element;
  let cursor: unknown = element;
  for (const part of field.split('.')) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** Partition items into kept/discarded by the AND of the conditions. */
export function filterItems(
  items: unknown[],
  conditions: FilterCondition[],
): { kept: unknown[]; discarded: unknown[] } {
  const kept: unknown[] = [];
  const discarded: unknown[] = [];
  const active = conditions.filter((condition) => condition && condition.checkOperator);
  for (const element of items) {
    const passes = active.every((condition) =>
      checkConditionResult(fieldValue(element, condition.field), condition.checkValue, condition.checkOperator),
    );
    (passes ? kept : discarded).push(element);
  }
  return { kept, discarded };
}
