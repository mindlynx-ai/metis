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
 * The workflow save schema, matching Helix's workflowMetaSchema
 * (helix-core schemas/workflow.ts) shape exactly so a Metis workflow IS
 * a valid Helix workflow: flat top-level nodes/edges, a node's config
 * lives under `data.config`, edges carry a nullable `sourceHandle`. The
 * only deliberate divergence is `type`: an open string gated by the
 * catalogue + publish validation, not Helix's closed node-type enum
 * (which names agents, skills, etc. that the open build does not carry).
 */
import { z } from 'zod';

const nodeOutputSpecSchema = z.object({
  manualData: z.array(z.object({ key: z.string(), type: z.string(), value: z.unknown() })),
});

// Per-node run policy the inspector persists; the engine enforces
// retries/backoff/timeout and onFailure around the handler call.
const nodePolicySchema = z.object({
  retries: z.number().int().nonnegative().optional(),
  backoffSeconds: z.number().nonnegative().optional(),
  timeoutSeconds: z.number().nonnegative().optional(),
  onFailure: z.enum(['halt', 'continue']).optional(),
  // Accepted for origin round-trip; the open engine does not act on it.
  idempotencyKey: z.string().optional(),
});

export const workflowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  version: z.string().min(1),
  data: z.object({
    label: z.string(),
    description: z.string().optional(),
    config: z.record(z.string(), z.unknown()),
    outputs: z.array(nodeOutputSpecSchema).default([]),
    metadata: z.record(z.string(), z.unknown()).default({}),
    singleExecution: z.boolean().optional(),
    policy: nodePolicySchema.optional(),
  }),
  delay: z.number().int().nonnegative().optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});

export const workflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().nullable(),
});

// The workflow-level cloud-routing setting: the "allow cloud" toggle plus
// the consent stamp the gate writes. Cloud never binds without both.
const cloudRoutingSchema = z.object({
  enabled: z.boolean(),
  consentAt: z.string().optional(),
});

/** Create body = Helix workflowMetaSchema (open subset + accepted pass-through). */
export const workflowMetaSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  type: z.enum(['workflow', 'api']).default('workflow'),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  nodes: z.array(workflowNodeSchema).min(1, 'Workflow must have at least one node'),
  edges: z.array(workflowEdgeSchema).default([]),
  cloudRouting: cloudRoutingSchema.optional(),
  // Helix carries these; the open build accepts them so a Helix workflow
  // round-trips, but stores/acts on none of them (no closed logic).
  flowType: z.string().optional(),
  workflowType: z.string().optional(),
  holdState: z.boolean().optional(),
  lineage: z.unknown().optional(),
  producesMemory: z.unknown().optional(),
});

/** Update body = the same shape, all fields optional (Helix updateWorkflowSchema). */
export const updateWorkflowMetaSchema = workflowMetaSchema.partial();

export type WorkflowNodeInput = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdgeInput = z.infer<typeof workflowEdgeSchema>;
export type WorkflowMetaInput = z.infer<typeof workflowMetaSchema>;

/** A stored version item projected to the Helix-flat wire shape. */
export interface HelixWorkflow {
  id: string;
  name: string;
  description?: string;
  type: string;
  status: string;
  version: number;
  changeset: number;
  deleted?: boolean;
  nodes: unknown[];
  edges: unknown[];
  cloudRouting?: { enabled?: boolean; consentAt?: string };
}

/** Flatten a stored `{definition:{nodes,edges}}` version item to Helix-flat. */
export function toHelixWorkflow(item: {
  workflowId: string;
  name: string;
  description?: string;
  type: string;
  status: string;
  version: number;
  changeset: number;
  deleted?: boolean;
  definition: Record<string, unknown>;
}): HelixWorkflow {
  const definition = (item.definition ?? {}) as {
    nodes?: unknown[];
    edges?: unknown[];
    cloudRouting?: { enabled?: boolean; consentAt?: string };
  };
  return {
    id: item.workflowId,
    name: item.name,
    description: item.description,
    type: item.type,
    status: item.status,
    version: item.version,
    changeset: item.changeset,
    deleted: item.deleted,
    nodes: definition.nodes ?? [],
    edges: definition.edges ?? [],
    cloudRouting: definition.cloudRouting,
  };
}
