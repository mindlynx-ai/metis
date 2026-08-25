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
 * The pure half of the operation parameters widget: the shape of one field and
 * the rule for turning a set of them into a node's stored `params`.
 *
 * It lives apart from `OperationParams.tsx` because that file renders an
 * editor, the editor reaches for `window` at import time, and the unit suite
 * runs on Node with no DOM (`vitest.config.ts`). Importing the component to
 * reach one pure function would fail before a single assertion ran. The repo's
 * standing split - pure helpers get unit tests, anything rendered gets
 * Playwright - is what this file is for.
 */
import { type OperationParameter } from '../../api.js';

export interface Field {
  key: string;
  value: string;
  /** 'declared' + 'placeholder' fields have a fixed key; 'extra' keys are editable. */
  kind: 'declared' | 'placeholder' | 'extra';
  label?: string;
  type?: OperationParameter['type'];
  required?: boolean;
  placeholder?: string;
  description?: string;
}

/**
 * What actually gets stored as the node's `params`. A blank box means "not
 * set", never "set to empty": an optional field nobody filled in must not
 * reach the API. Slack answers `limit=` with "must provide a number", so
 * declaring an optional parameter would otherwise break the call for every
 * author who left it alone.
 */
export function paramsFromFields(fields: Field[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const field of fields) {
    const key = field.key.trim();
    if (key !== '' && field.value !== '') params[key] = field.value;
  }
  return params;
}
