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
 * Pure helper bundled into workflow code (deterministic, import-free):
 * the routing choice one dispatch carries to the capability resolver.
 */
import type { CloudRoutingContext, RuntimeNode, WorkflowCloudRouting } from '../types.js';

/**
 * The workflow toggle + this node's override (the inspector saves the
 * override under data.metadata.cloudRouting, which rides the node spread
 * in initiateWorkflow). Absent when neither is set.
 */
export function cloudRoutingFor(
  workflow: WorkflowCloudRouting | undefined,
  node: RuntimeNode,
): CloudRoutingContext | undefined {
  const override = (
    node as {
      data?: { metadata?: { cloudRouting?: { mode?: 'local' | 'cloud' | 'auto'; thresholdBytes?: number } } };
    }
  ).data?.metadata?.cloudRouting;
  if (!workflow && !override) return undefined;
  return {
    enabled: workflow?.enabled,
    consentAt: workflow?.consentAt,
    nodeMode: override?.mode,
    thresholdBytes: override?.thresholdBytes,
  };
}
