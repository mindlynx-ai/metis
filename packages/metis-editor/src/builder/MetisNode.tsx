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
 * The single custom canvas node: the design's .fnode - a horizontal
 * card with a category-tinted left bar and icon tile, the step's name and type,
 * a run-state slot, its ports (one output, or two labelled Yes/No for a logic
 * branch), and a hover "+" to add the next step straight off the output.
 *
 * The flex layout lives on an inner wrapper: React Flow measures handle/edge
 * bounds off .metis-node itself, and making that element a flex container drops
 * the edges on load, so the node element stays a plain block.
 */
import { useEffect } from 'react';
import { Handle, Position, useStore, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { Icon } from '../ui/Icon.js';
import { hasInput, nodeIcon, outputPorts } from './node-visual.js';

export interface MetisNodeData extends Record<string, unknown> {
  nodeType: string;
  category: string;
  label: string;
  config?: Record<string, unknown>;
  runStatus?: 'running' | 'completed' | 'failed' | 'orphaned';
  runBadge?: string;
  /** Where this step is set to run ('cloud' | 'auto'); absent = this computer. */
  cloudMode?: 'cloud' | 'auto';
  /** The last run chose the cloud but this step ran here instead. */
  runDegraded?: boolean;
  onAddAfter?: (nodeId: string, sourceHandle?: string) => void;
}

/** The routing chip: filled = cloud, outlined + A = automatic, cloud-off =
 *  degraded ("Ran here instead"). Hidden below ~0.6 zoom - at that height
 *  the workflow's shape matters, not per-step routing. */
function CloudChip({ mode, degraded }: { mode?: 'cloud' | 'auto'; degraded?: boolean }) {
  const zoom = useStore((state) => state.transform[2]);
  if (zoom < 0.6) return null;
  if (degraded) {
    const label = "The cloud wasn't reachable; this step ran on this computer";
    return (
      <span className="cloud-chip degraded" role="img" aria-label={label} title={label}>
        <Icon name="cloud-off" size={15} />
      </span>
    );
  }
  if (!mode) return null;
  const label = mode === 'cloud' ? 'Runs in the cloud' : 'Runs in the cloud for big data';
  return (
    <span className={`cloud-chip${mode === 'auto' ? ' auto' : ''}`} role="img" aria-label={label} title={label}>
      <Icon name="cloud" size={15} fill={mode === 'cloud'} />
    </span>
  );
}

/** "Ran here instead", beside the step name; hides with the chip when zoomed out. */
function DegradedBadge() {
  const zoom = useStore((state) => state.transform[2]);
  if (zoom < 0.6) return null;
  return <span className="fnode-badge b-degraded">Ran here instead</span>;
}

const CATEGORIES = new Set(['trigger', 'logic', 'transform', 'integration']);

function StateIcon({ status }: { status: MetisNodeData['runStatus'] }) {
  if (status === 'running') return <span className="fnode-spin" aria-label="running" />;
  if (status === 'completed') return <Icon name="check" size={15} />;
  if (status === 'failed') return <Icon name="x" size={15} />;
  if (status === 'orphaned') return <Icon name="minus" size={15} />;
  return null;
}

export function MetisNode(props: NodeProps) {
  const data = props.data as MetisNodeData;
  const category = CATEGORIES.has(data.category) ? data.category : 'integration';
  const state = data.runStatus;
  const ports = outputPorts(data.nodeType, data.config);
  // A switch's branch handles are config-driven: when the set changes, React
  // Flow has cached the old handle bounds and must remeasure or the edges float.
  const portSignature = ports.map((port) => port.id ?? 'out').join(',');
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    updateNodeInternals(props.id);
  }, [props.id, portSignature, updateNodeInternals]);
  const className = ['metis-node', `cat-${category}`, props.selected ? 'selected' : '', state ? `is-${state}` : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} data-node-type={data.nodeType}>
      <div className="fnode-inner">
        <span className="fnode-icon" aria-hidden="true">
          <Icon name={nodeIcon(data.nodeType, category)} size={17} />
        </span>
        <div className="fnode-body">
          <div className="fnode-name">
            {data.label}
            {data.runBadge && <span className="fnode-badge">{data.runBadge}</span>}
            {data.runDegraded && <DegradedBadge />}
          </div>
          <div className="fnode-sub">{data.nodeType}</div>
        </div>
        <CloudChip mode={data.cloudMode} degraded={data.runDegraded} />
        {state && (
          <span className="fnode-state">
            <StateIcon status={state} />
          </span>
        )}
      </div>

      {hasInput(category) && <Handle type="target" position={Position.Left} />}
      {ports.map((port) => (
        <Handle
          key={port.id ?? 'out'}
          type="source"
          position={Position.Right}
          id={port.id}
          style={{ top: port.top }}
        />
      ))}
      {ports.map(
        (port) =>
          port.label && (
            <span key={`l-${port.id}`} className="fnode-port-label" style={{ top: port.top }}>
              {port.label}
            </span>
          ),
      )}

      {/* Single-output nodes get a hover "+" to add the next step inline. */}
      {ports.length === 1 && data.onAddAfter && (
        <button
          type="button"
          className="fnode-plus nodrag"
          aria-label="Add a step after this one"
          title="Add step"
          onClick={(event) => {
            event.stopPropagation();
            data.onAddAfter?.(props.id);
          }}
        >
          <Icon name="plus" size={13} />
        </button>
      )}
    </div>
  );
}
