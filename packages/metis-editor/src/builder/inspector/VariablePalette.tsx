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
 * "What it receives": the variables every upstream step passes in, grouped by
 * source and shown as chips. Clicking a chip drops its `{{node-...}}` reference
 * into the config field you were editing (or copies it if none is focused).
 * The chip's mousedown is prevented so focusing it never steals focus from the
 * field being filled - the classic insert-into-last-field pattern.
 */
import type { UpstreamSource } from './upstream-variables.js';

export function VariablePalette({
  sources,
  onInsert,
}: {
  sources: UpstreamSource[];
  onInsert(reference: string): void;
}) {
  if (sources.length === 0) {
    return (
      <p className="io-empty">Connect a step into this one and its data will appear here to use.</p>
    );
  }
  return (
    <div className="io-list var-palette">
      {sources.map((source) => (
        <div className="io-source" key={source.nodeId}>
          <div className="io-source-name">{source.label}</div>
          <div className="chips">
            {source.variables.map((variable) => (
              <button
                key={variable.reference}
                type="button"
                className={`ref-chip cat-${source.category}`}
                title={`Insert ${variable.reference}`}
                aria-label={`Insert ${source.label} ${variable.key}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onInsert(variable.reference)}
              >
                <span className="ref-name">{variable.key}</span>
                {variable.type && <span className="ref-type">{variable.type}</span>}
                <span className="ref-copy" aria-hidden="true">
                  Use
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
