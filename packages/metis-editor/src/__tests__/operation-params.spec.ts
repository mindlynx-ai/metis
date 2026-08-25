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
 * What an author's filled-in form actually sends. The empty case is the one
 * that matters: an optional parameter nobody typed into must not reach the
 * API. Slack answers `conversations.list?limit=` with "must provide a number",
 * so storing the blank box would break the call for everyone who left an
 * optional field alone.
 */
import { describe, it, expect } from 'vitest';
import { paramsFromFields, type Field } from '../builder/inspector/operation-params.js';

const field = (key: string, value: string, kind: Field['kind'] = 'declared'): Field => ({
  key,
  value,
  kind,
});

describe('paramsFromFields', () => {
  it('drops the optional fields nobody filled in', () => {
    expect(
      paramsFromFields([
        field('channel', 'C0BL5TH6W90'),
        field('text', 'Reorder drafted for SKU-2'),
        field('thread_ts', ''),
      ]),
    ).toEqual({ channel: 'C0BL5TH6W90', text: 'Reorder drafted for SKU-2' });
  });

  it('drops a freeform row with no key, and trims the keys it keeps', () => {
    expect(paramsFromFields([field('  limit  ', '100', 'extra'), field('', 'orphan', 'extra')])).toEqual({
      limit: '100',
    });
  });

  it('keeps a zero, which is a value and not a blank', () => {
    expect(paramsFromFields([field('limit', '0')])).toEqual({ limit: '0' });
  });
});
