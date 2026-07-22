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
import { suggestedStepTypes, suggestedTitle } from '../builder/suggested-steps.js';

describe('suggestedStepTypes', () => {
  it('nudges a brand-new canvas to start with a trigger', () => {
    expect(suggestedStepTypes(undefined, false)).toContain('webhookconfig');
    expect(suggestedTitle(undefined, false)).toBe('Start with a trigger');
  });

  it('suggests shaping/routing after a trigger', () => {
    expect(suggestedStepTypes('trigger', true)).toEqual(
      expect.arrayContaining(['code', 'switch']),
    );
    expect(suggestedTitle('trigger', true)).toBe('Suggested next');
  });

  it('suggests actions after a step, and does not lead with a trigger', () => {
    expect(suggestedStepTypes('integration', true)).not.toContain('webhookconfig');
    expect(suggestedStepTypes('integration', true)).toContain('sendgrid');
  });

  it('offers common steps when adding to a non-empty canvas with no source step', () => {
    expect(suggestedStepTypes(undefined, true)).not.toContain('webhookconfig');
    expect(suggestedStepTypes(undefined, true).length).toBeGreaterThan(0);
  });
});
