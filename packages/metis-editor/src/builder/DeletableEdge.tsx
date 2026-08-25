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
 * An edge you can actually remove.
 *
 * Drawing a link was always possible; undoing it was not. There was no
 * `removeEdge` in the store and no `onEdgesChange` on the canvas, so the only
 * way to unlink two steps was to delete one of them and build it again. A
 * tester found this in minutes.
 *
 * Selecting an edge and pressing Backspace works now, but a keyboard gesture
 * nobody can see is not an answer for an audience that does not read manuals.
 * So the link carries its own control: hover it, or select it, and a small
 * cross appears at the midpoint. The button is a real button - reachable by
 * keyboard, named for a screen reader - not a click handler on an SVG path.
 */
import { memo, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { useFlow } from '../flow-store.js';

function DeletableEdgeInner({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  selected,
}: EdgeProps) {
  const removeEdge = useFlow((state) => state.removeEdge);
  // React state, not a CSS :hover rule. React Flow's edge <g> does not reliably
  // take :hover - the pointer lands on its own interaction path, which is not a
  // descendant of anything we style - so a `.react-flow__edge:hover .edge-drop`
  // rule leaves the control permanently invisible AND still clickable. Found by
  // driving a real mouse at it; every synthetic click had passed.
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {/*
        A transparent fat line over the thin visible one. A 2px stroke is a
        pixel-hunt to hit; this gives the same link a forgiving target without
        changing how it looks.
      */}
      <path
        d={path}
        className="edge-hit"
        fill="none"
        strokeWidth={18}
        stroke="transparent"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={`edge-drop${selected || hovered ? ' is-on' : ''}`}
          // EdgeLabelRenderer draws outside the SVG, so the midpoint has to be
          // placed by hand. pointerEvents is off for the layer as a whole and
          // turned back on here, which is the documented pattern.
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
          aria-label="Remove this link"
          title="Remove this link"
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onClick={(event) => {
            event.stopPropagation();
            removeEdge(id);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

export const DeletableEdge = memo(DeletableEdgeInner);
