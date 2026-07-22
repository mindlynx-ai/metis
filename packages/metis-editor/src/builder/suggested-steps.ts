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
 * The featured "suggested" steps at the top of the picker. A curated heuristic
 * (no usage data yet): an empty canvas is nudged to start with a trigger - so
 * the workflow can actually run and publish - and once there is a step, the
 * suggestions follow from what it is (shape/route after a trigger, act/branch
 * after a step). The types are featured; they still appear in their categories.
 */

const AFTER_TRIGGER = ['code', 'api', 'switch', 'sendgrid'];
const AFTER_LOGIC = ['sendgrid', 'slack', 'api', 'code'];
const AFTER_STEP = ['sendgrid', 'slack', 'switch', 'api', 'code'];
const START_TRIGGERS = ['webhookconfig', 'scheduleconfig', 'apiconfig'];
const COMMON_STEPS = ['sendgrid', 'api', 'code', 'switch'];

export function suggestedStepTypes(fromCategory: string | undefined, hasNodes: boolean): string[] {
  if (fromCategory === 'trigger') return AFTER_TRIGGER;
  if (fromCategory === 'logic') return AFTER_LOGIC;
  if (fromCategory) return AFTER_STEP;
  // No source step in play: a brand-new canvas needs a trigger first.
  return hasNodes ? COMMON_STEPS : START_TRIGGERS;
}

export function suggestedTitle(fromCategory: string | undefined, hasNodes: boolean): string {
  return !fromCategory && !hasNodes ? 'Start with a trigger' : 'Suggested next';
}
