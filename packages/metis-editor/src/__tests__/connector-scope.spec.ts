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
 * The connector picker's scoping: a node's connectorRef field carries an
 * `x-helix-options` hint (e.g. `?provider=sendgrid`); the picker must scope its
 * list to matching connections so a SendGrid step cannot pick an unrelated one.
 */
import { describe, it, expect } from 'vitest';
import { parseConnectorScope } from '../builder/inspector/connector-scope.js';

describe('parseConnectorScope', () => {
  it('returns an empty scope for no hint or a hint with no query', () => {
    expect(parseConnectorScope(undefined)).toEqual({});
    expect(parseConnectorScope('/_resource/connectors')).toEqual({});
  });

  it('extracts the provider query param', () => {
    expect(parseConnectorScope('/_resource/connectors?provider=sendgrid')).toEqual({
      provider: 'sendgrid',
    });
    expect(parseConnectorScope('/x?provider=sendgrid&category=communication')).toEqual({
      provider: 'sendgrid',
    });
  });
});
