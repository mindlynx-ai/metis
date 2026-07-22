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
import { inferSampleOutputs, outputsFromRows } from '../builder/inspector/sample-outputs.js';

describe('inferSampleOutputs', () => {
  it('infers one level of keys with JSON types', () => {
    const { rows, error } = inferSampleOutputs(
      '{"firstName":"Ada","age":36,"active":true,"tags":["x"],"meta":{"a":1},"nothing":null}',
    );
    expect(error).toBeUndefined();
    expect(rows).toEqual([
      { key: 'firstName', type: 'string', value: 'Ada' },
      { key: 'age', type: 'number', value: 36 },
      { key: 'active', type: 'boolean', value: true },
      { key: 'tags', type: 'array', value: ['x'] },
      { key: 'meta', type: 'object', value: { a: 1 } },
      { key: 'nothing', type: 'null', value: null },
    ]);
  });

  it('applies a prefix so a webhook body nests under body.<key>', () => {
    const { rows } = inferSampleOutputs('{"firstName":"Grace","email":"g@x.test"}', 'body.');
    expect(rows.map((row) => row.key)).toEqual(['body.firstName', 'body.email']);
  });

  it('returns an error for invalid JSON, never throws', () => {
    const { rows, error } = inferSampleOutputs('{not json');
    expect(rows).toEqual([]);
    expect(error).toMatch(/valid JSON/i);
  });

  it('rejects a non-object sample (array or primitive)', () => {
    expect(inferSampleOutputs('[1,2,3]').error).toMatch(/object/i);
    expect(inferSampleOutputs('"just a string"').error).toMatch(/object/i);
  });

  it('treats empty/whitespace input as no rows, no error', () => {
    expect(inferSampleOutputs('   ')).toEqual({ rows: [] });
  });
});

describe('outputsFromRows', () => {
  it('wraps rows in the manualData envelope data.outputs expects', () => {
    const rows = [{ key: 'firstName', type: 'string', value: 'Ada' }];
    expect(outputsFromRows(rows)).toEqual([{ manualData: rows }]);
  });

  it('produces an empty array for no rows (clears declared outputs)', () => {
    expect(outputsFromRows([])).toEqual([]);
  });
});
