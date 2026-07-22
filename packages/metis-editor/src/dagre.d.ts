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

// Minimal ambient types for the small @dagrejs/dagre surface the editor uses
// (the package ships no bundled .d.ts). ponytail: only what layout.ts calls.
declare module '@dagrejs/dagre' {
  interface DagreNode {
    x: number;
    y: number;
  }
  class Graph {
    setDefaultEdgeLabel(callback: () => Record<string, unknown>): Graph;
    setGraph(options: Record<string, unknown>): Graph;
    setNode(id: string, node: { width: number; height: number }): Graph;
    setEdge(source: string, target: string): Graph;
    node(id: string): DagreNode;
  }
  const dagre: {
    graphlib: { Graph: new () => Graph };
    layout: (graph: Graph) => void;
  };
  export default dagre;
}
