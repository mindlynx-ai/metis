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
 * The builder's source of truth: the canonical flat
 * definition shape (nodes[], edges[], XYFlow-native source/target).
 * The canvas mirrors this store; it never owns state of its own.
 */
import { create } from 'zustand';
import { api, type CloudRouting, type NodePolicy, type WorkflowEdge, type WorkflowNode } from './api.js';

export interface FlowState {
  workflowId?: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  exists: boolean;
  dirty: boolean;
  /** Lifecycle: 'draft' until published, then 'published'. */
  status: string;
  /** The workflow's "Allow cloud" toggle + consent stamp; rides every save. */
  cloudRouting?: CloudRouting;
  selectedNodeId?: string;
  /** Bumped on every applyLayout so the canvas can re-fit after nodes settle. */
  layoutVersion: number;
  setName(name: string): void;
  setStatus(status: string): void;
  /** Clear to a fresh, empty, unsaved workflow (the "New workflow" route). */
  reset(): void;
  load(workflowId: string): Promise<void>;
  /** Add a node; returns its new id so the caller can connect it. */
  addNode(input: {
    type: string;
    label: string;
    config?: Record<string, unknown>;
    position?: { x: number; y: number };
  }): string;
  moveNode(nodeId: string, position: { x: number; y: number }): void;
  applyLayout(positions: { id: string; position: { x: number; y: number } }[]): void;
  connect(input: { source: string; target: string; sourceHandle?: string | null }): void;
  removeNode(nodeId: string): void;
  select(nodeId?: string): void;
  updateConfig(nodeId: string, config: Record<string, unknown>): void;
  /** Merge one config key, preserving every other (incl. out-of-schema) key. */
  updateConfigField(nodeId: string, key: string, value: unknown): void;
  updateLabel(nodeId: string, label: string): void;
  updateDescription(nodeId: string, description: string): void;
  updateOutputs(nodeId: string, outputs: unknown[]): void;
  updateMetadata(nodeId: string, metadata: Record<string, unknown>): void;
  updatePolicy(nodeId: string, policy: NodePolicy): void;
  /** Replace the workflow's cloud routing (toggle, consent stamp, reset). */
  setCloudRouting(cloudRouting: CloudRouting | undefined): void;
  /** Create (if new) or update; returns the server-assigned workflow id. */
  save(): Promise<string | undefined>;
}

/** Immutably patch one node's data by id; every other node is untouched. */
const patchNodeData = (
  nodes: WorkflowNode[],
  nodeId: string,
  patch: (data: WorkflowNode['data']) => WorkflowNode['data'],
): WorkflowNode[] =>
  nodes.map((node) => (node.id === nodeId ? { ...node, data: patch(node.data) } : node));

const newId = () =>
  `node-${crypto.randomUUID()}`;

export const useFlow = create<FlowState>((set, get) => ({
  name: 'Untitled workflow',
  nodes: [],
  edges: [],
  exists: false,
  dirty: false,
  status: 'draft',
  layoutVersion: 0,

  setName(name: string) {
    set({ name, dirty: true });
  },

  setStatus(status: string) {
    set({ status });
  },

  reset() {
    set({
      workflowId: undefined,
      name: 'Untitled workflow',
      nodes: [],
      edges: [],
      exists: false,
      dirty: false,
      status: 'draft',
      cloudRouting: undefined,
      selectedNodeId: undefined,
    });
  },

  async load(workflowId: string) {
    try {
      const item = await api.getWorkflow(workflowId);
      set({
        workflowId,
        name: item.name,
        nodes: item.nodes ?? [],
        edges: item.edges ?? [],
        exists: true,
        dirty: false,
        status: item.status ?? 'draft',
        cloudRouting: item.cloudRouting,
        selectedNodeId: undefined,
      });
    } catch {
      set({
        workflowId,
        name: 'Untitled workflow',
        nodes: [],
        edges: [],
        exists: false,
        dirty: false,
        status: 'draft',
        cloudRouting: undefined,
        selectedNodeId: undefined,
      });
    }
  },

  addNode(input) {
    const node: WorkflowNode = {
      id: newId(),
      type: input.type,
      version: 'v1',
      data: { label: input.label, config: input.config ?? {}, outputs: [], metadata: {} },
      position: input.position,
    };
    set((state) => ({ nodes: [...state.nodes, node], dirty: true }));
    return node.id;
  },

  moveNode(nodeId, position) {
    set((state) => ({
      nodes: state.nodes.map((node) => (node.id === nodeId ? { ...node, position } : node)),
      dirty: true,
    }));
  },

  applyLayout(positions) {
    const byId = new Map(positions.map((entry) => [entry.id, entry.position]));
    set((state) => ({
      nodes: state.nodes.map((node) =>
        byId.has(node.id) ? { ...node, position: byId.get(node.id) } : node,
      ),
      dirty: true,
      layoutVersion: state.layoutVersion + 1,
    }));
  },

  connect(input) {
    set((state) => {
      const exists = state.edges.some(
        (candidate) => candidate.source === input.source && candidate.target === input.target,
      );
      if (exists || input.source === input.target) return state;
      const edge: WorkflowEdge = {
        id: `edge-${input.source}-${input.target}`,
        source: input.source,
        target: input.target,
        sourceHandle: input.sourceHandle ?? null,
      };
      return { ...state, edges: [...state.edges, edge], dirty: true };
    });
  },

  removeNode(nodeId) {
    set((state) => ({
      nodes: state.nodes.filter((node) => node.id !== nodeId),
      edges: state.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
      selectedNodeId: state.selectedNodeId === nodeId ? undefined : state.selectedNodeId,
      dirty: true,
    }));
  },

  select(nodeId) {
    set({ selectedNodeId: nodeId });
  },

  updateConfig(nodeId, config) {
    set((state) => ({
      nodes: patchNodeData(state.nodes, nodeId, (data) => ({ ...data, config })),
      dirty: true,
    }));
  },

  updateConfigField(nodeId, key, value) {
    set((state) => ({
      nodes: patchNodeData(state.nodes, nodeId, (data) => {
        const config = { ...(data.config ?? {}) };
        // undefined clears the key; anything else merges over it.
        if (value === undefined) delete config[key];
        else config[key] = value;
        return { ...data, config };
      }),
      dirty: true,
    }));
  },

  updateLabel(nodeId, label) {
    set((state) => ({
      nodes: patchNodeData(state.nodes, nodeId, (data) => ({ ...data, label })),
      dirty: true,
    }));
  },

  updateDescription(nodeId, description) {
    set((state) => ({
      nodes: patchNodeData(state.nodes, nodeId, (data) => ({ ...data, description })),
      dirty: true,
    }));
  },

  updateOutputs(nodeId, outputs) {
    set((state) => ({
      nodes: patchNodeData(state.nodes, nodeId, (data) => ({ ...data, outputs })),
      dirty: true,
    }));
  },

  updateMetadata(nodeId, metadata) {
    set((state) => ({
      nodes: patchNodeData(state.nodes, nodeId, (data) => ({
        ...data,
        metadata: { ...(data.metadata ?? {}), ...metadata },
      })),
      dirty: true,
    }));
  },

  updatePolicy(nodeId, policy) {
    set((state) => ({
      nodes: patchNodeData(state.nodes, nodeId, (data) => ({
        ...data,
        policy: { ...(data.policy ?? {}), ...policy },
      })),
      dirty: true,
    }));
  },

  setCloudRouting(cloudRouting) {
    set({ cloudRouting, dirty: true });
  },

  async save() {
    const { workflowId, name, nodes, edges, exists, cloudRouting } = get();
    if (exists && workflowId) {
      await api.updateWorkflow(workflowId, nodes, edges, name, cloudRouting);
      set({ dirty: false });
      return workflowId;
    }
    const created = await api.createWorkflow(name, nodes, edges, cloudRouting);
    set({ workflowId: created.id, exists: true, dirty: false });
    return created.id;
  },
}));
