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
 * The builder canvas, a slim restyled port of the origin
 * BuilderCanvas: XYFlow with the single Metis node type, add via the
 * picker, connect by dragging handles, delete with the keyboard. The
 * flow store is the source of truth; the canvas mirrors it. Three
 * couplings the original carried are absent here: an assistant
 * side-panel, analytics events on every interaction, and an external
 * command bus that could drive the graph. This canvas talks to nothing
 * but the flow store.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  MarkerType,
  Panel,
  ReactFlow,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type Node,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useFlow } from '../flow-store.js';
import { Icon } from '../ui/Icon.js';
import { MetisNode } from './MetisNode.js';
import { DeletableEdge } from './DeletableEdge.js';
import { layoutPositions, type LayoutDirection } from './layout.js';
import type { CatalogueEntry } from '../api.js';

const nodeTypes = { metis: MetisNode };
// Module scope, like nodeTypes: XYFlow warns and re-renders the whole graph if
// this object is rebuilt every render.
const edgeTypes = { deletable: DeletableEdge };

/** The per-step "Where it runs" choice ('local' and absent draw no chip). */
function cloudModeOf(node: { data?: { metadata?: Record<string, unknown> } }): 'cloud' | 'auto' | undefined {
  const mode = (node.data?.metadata?.cloudRouting as { mode?: string } | undefined)?.mode;
  return mode === 'cloud' || mode === 'auto' ? mode : undefined;
}

/** Dagre "tidy" controls (react-flow skill): re-layout the graph, then fit. */
function LayoutControls() {
  const flow = useFlow();
  const { fitView } = useReactFlow();
  // Fit AFTER the new positions commit and React Flow re-measures: two
  // animation frames, not a fixed timeout, so the viewport frames correctly.
  useEffect(() => {
    if (flow.layoutVersion === 0) return undefined;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => fitView({ duration: 300, padding: 0.2 }));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [flow.layoutVersion, fitView]);
  const tidy = (direction: LayoutDirection) => {
    flow.applyLayout(layoutPositions(flow.nodes, flow.edges, direction));
  };
  return (
    <div className="layout-controls" role="group" aria-label="Auto layout">
      <button type="button" className="btn btn-sm" onClick={() => tidy('TB')}>
        Tidy vertical
      </button>
      <button type="button" className="btn btn-sm" onClick={() => tidy('LR')}>
        Tidy horizontal
      </button>
    </div>
  );
}

/** The design's .b-zoom control: zoom out / level / zoom in / fit to view. */
function BuilderZoom() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  return (
    <div className="b-zoom" role="group" aria-label="Zoom">
      <button type="button" className="btn btn-icon" aria-label="Zoom out" onClick={() => zoomOut()}>
        <Icon name="minus" size={14} />
      </button>
      <span className="zoom-val mono">{Math.round(zoom * 100)}%</span>
      <button type="button" className="btn btn-icon" aria-label="Zoom in" onClick={() => zoomIn()}>
        <Icon name="plus" size={14} />
      </button>
      <button type="button" className="btn btn-icon" aria-label="Fit to view" onClick={() => fitView({ duration: 300, padding: 0.2 })}>
        <Icon name="grid" size={14} />
      </button>
    </div>
  );
}

export function BuilderCanvas({
  catalogue,
  onAddAfter,
  runStates,
  runBadges,
  runDegraded,
}: {
  catalogue: CatalogueEntry[];
  onAddAfter?: (nodeId: string) => void;
  runStates?: Record<string, 'running' | 'completed' | 'failed' | 'orphaned'>;
  runBadges?: Record<string, string>;
  /** Steps the last run routed to the cloud but ran here instead, with the
   *  reason that run recorded. */
  runDegraded?: Record<string, { why?: string }>;
}) {
  const flow = useFlow();
  // Routing chips only render when the workflow's cloud toggle is on: with
  // it off, a per-step "In the cloud" setting is inert and must not claim
  // otherwise on the canvas.
  const cloudEnabled = Boolean(flow.cloudRouting?.enabled);

  const categoryOf = useCallback(
    (type: string): string => {
      const entry = catalogue.find((candidate) => candidate.type === type);
      return entry?.category ?? 'integration';
    },
    [catalogue],
  );

  const labelOf = useCallback(
    (type: string): string => {
      const entry = catalogue.find((candidate) => candidate.type === type);
      return (entry?.palette?.label as string) ?? type;
    },
    [catalogue],
  );

  // XYFlow measures each node after mount and reports it as a 'dimensions'
  // change. A controlled flow must carry that measurement back on the node
  // objects it passes in - drop it and any node this memo recreates (a run
  // state painting, a selection) re-enters the unmeasured state and sticks
  // at visibility:hidden, because its DOM size never changes again.
  const measured = useRef(new Map<string, { width: number; height: number }>());

  const nodes: Node[] = useMemo(
    () =>
      flow.nodes.map((node, index) => ({
        id: node.id,
        type: 'metis',
        position: node.position ?? { x: 80 + index * 280, y: 120 },
        selected: flow.selectedNodeId === node.id,
        measured: measured.current.get(node.id),
        data: {
          nodeType: node.type,
          category: categoryOf(node.type),
          label: node.data?.label ?? labelOf(node.type),
          // A switch's branch handles come from its config (one per option).
          config: node.data?.config,
          onAddAfter,
          runStatus: runStates?.[node.id],
          runBadge: runBadges?.[node.id],
          cloudMode: cloudEnabled ? cloudModeOf(node) : undefined,
          runDegraded: runDegraded?.[node.id],
        },
      })),
    [flow.nodes, flow.selectedNodeId, categoryOf, labelOf, onAddAfter, runStates, runBadges, runDegraded, cloudEnabled],
  );

  // Which link the pointer or keyboard is on. Canvas-only state: it is not part
  // of the workflow, so it does not belong in the store the way selectedNodeId
  // does (that one drives the inspector).
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | undefined>(undefined);

  const edges: Edge[] = useMemo(
    () =>
      flow.edges.map((edge, index) => {
        const sourceType = flow.nodes.find((node) => node.id === edge.source)?.type;
        const category = sourceType ? categoryOf(sourceType) : 'integration';
        return {
          id: edge.id ?? `edge-${index}-${edge.source}-${edge.target}`,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          type: 'deletable',
          selected: (edge.id ?? `edge-${index}-${edge.source}-${edge.target}`) === selectedEdgeId,
          style: { stroke: `var(--cat-${category}-dot)`, strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: `var(--cat-${category}-dot)` },
        };
      }),
    [flow.edges, flow.nodes, categoryOf, selectedEdgeId],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const change of changes) {
        if (change.type === 'dimensions' && change.dimensions) {
          measured.current.set(change.id, change.dimensions);
        }
        if (change.type === 'position' && change.position && !change.dragging) {
          flow.moveNode(change.id, change.position);
        }
        if (change.type === 'remove') {
          flow.removeNode(change.id);
        }
        if (change.type === 'select') {
          flow.select(change.selected ? change.id : undefined);
        }
      }
    },
    [flow],
  );

  /**
   * Edge changes were never wired at all, and that is the whole bug.
   *
   * XYFlow only applies changes itself when it owns the edges (`defaultEdges`).
   * With a controlled `edges` prop it hands every change to `onEdgesChange` and
   * drops them on the floor if that prop is missing - so `select` never landed,
   * an edge could never reach `selected: true`, and `deleteKeyCode` therefore
   * found nothing to delete. Backspace looked broken because it WAS.
   */
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const change of changes) {
        if (change.type === 'remove') {
          flow.removeEdge(change.id);
          setSelectedEdgeId((current) => (current === change.id ? undefined : current));
        }
        if (change.type === 'select') {
          setSelectedEdgeId(change.selected ? change.id : undefined);
        }
      }
    },
    [flow],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        flow.connect({
          source: connection.source,
          target: connection.target,
          sourceHandle: connection.sourceHandle ?? null,
        });
      }
    },
    [flow],
  );

  return (
    <section className="builder-canvas" aria-label="Workflow canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        edgeTypes={edgeTypes}
        onConnect={onConnect}
        onNodeClick={(_event, node) => flow.select(node.id)}
        onPaneClick={() => {
          flow.select(undefined);
          setSelectedEdgeId(undefined);
        }}
        fitView={flow.nodes.length > 0}
        deleteKeyCode={['Backspace', 'Delete']}
        proOptions={{ hideAttribution: true }}
      >
        {flow.nodes.length > 1 && (
          <Panel position="top-right">
            <LayoutControls />
          </Panel>
        )}
        <Panel position="bottom-left">
          <BuilderZoom />
        </Panel>
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.4} />
      </ReactFlow>
    </section>
  );
}
