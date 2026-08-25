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
 * Writing a step and running it, in one place.
 *
 * The 384px inspector cannot be an IDE, and the loop a person is actually in -
 * write, run, read the error, fix the line - was spread across two tabs with the
 * code in one and the result in the other. This is that loop in one window:
 * what comes in, the editor, a sample input, Run, and what goes out.
 *
 * The failing line is marked in the gutter. That is only honest because the
 * engine now reports the author's own line numbers; it used to be two out, and
 * a confident marker on the wrong line is worse than none.
 *
 * Everything here is borrowed rather than rebuilt: VariablePalette, the run
 * hook the Test tab uses, and OutputsPanel. A second copy of any of them would
 * drift, and the last thing that drifted was the sample-input box quietly doing
 * nothing at all.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal.js';
import { CodeEditor } from './CodeEditor.js';
import { editorLanguageFor } from './editor-language.js';
import { failingLineOf } from './failing-line.js';
import { useTestRun } from './use-test-run.js';
import { VariablePalette } from './VariablePalette.js';
import { OutputsPanel } from './io-panels.js';
import { collectUpstreamVariables } from './upstream-variables.js';
import { activeInsertHandle } from './insert-reference.js';
import { toast } from '../../toast-store.js';
import { useFlow } from '../../flow-store.js';
import { type CatalogueEntry, type WorkflowNode } from '../../api.js';
import { validateCode, type SyntaxVerdict } from '../../code-api.js';

/** Which config key holds the source, honouring the deprecated alias. */
function sourceField(node: WorkflowNode): 'code' | 'script' {
  return node.data?.config?.script !== undefined && node.data?.config?.code === undefined
    ? 'script'
    : 'code';
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * One statement of where the problem is, not two. The engine's own message
 * already ends in "[line 3, column 39]" - it has to, because the run path has
 * no separate line field to read - so prefixing "Line 3:" as well says it
 * twice. Take the position off the message and lead with it.
 */
function verdictText(check: SyntaxVerdict): string {
  const message = (check.message ?? 'will not parse').replace(/\[line \d+, column \d+\]$/, '').trim();
  if (check.line === undefined) return message;
  const at = check.column === undefined ? `Line ${check.line}` : `Line ${check.line}, column ${check.column}`;
  return `${at}: ${message}`;
}

export function CodeWorkbench({
  node,
  entry,
  catalogue,
  onClose,
}: {
  node: WorkflowNode;
  entry: CatalogueEntry | undefined;
  catalogue: CatalogueEntry[];
  onClose(): void;
}) {
  const flow = useFlow();
  const field = sourceField(node);
  const value = String(node.data?.config?.[field] ?? '');
  const [input, setInput] = useState('{}');
  const test = useTestRun(node, async () => (await flow.save()) ?? flow.workflowId);

  const sources = useMemo(
    () => collectUpstreamVariables({ nodeId: node.id, nodes: flow.nodes, edges: flow.edges, catalogue }),
    [node.id, flow.nodes, flow.edges, catalogue],
  );

  // Whatever the last run blamed.
  const runLine = failingLineOf(test.nodeLog?.error?.message);
  const language = editorLanguageFor(field, 'textarea', node.data?.config);

  // What the engine says about the code as it stands, without running it.
  const [check, setCheck] = useState<{ ok: boolean; message?: string; line?: number; column?: number }>();
  const [checking, setChecking] = useState(false);

  const validate = useCallback(
    async (source: string) => {
      if (language !== 'javascript' && language !== 'python') return;
      setChecking(true);
      try {
        setCheck(await validateCode(language, source));
      } catch {
        // A failed check is not a failed step. Saying nothing beats claiming
        // somebody's code is broken because a request did not land.
        setCheck(undefined);
      } finally {
        setChecking(false);
      }
    },
    [language],
  );

  // Live, debounced. Long enough not to ask on every keystroke, short enough to
  // land before you have moved on.
  useEffect(() => {
    if (value.trim() === '') {
      setCheck(undefined);
      return undefined;
    }
    const timer = setTimeout(() => void validate(value), 700);
    return () => clearTimeout(timer);
  }, [value, validate]);

  // A syntax error wins: until it parses, the last run's failure is about code
  // that no longer exists.
  const markers = useMemo(() => {
    if (check && !check.ok && check.line) {
      return [{ line: check.line, column: check.column, message: check.message ?? 'will not parse' }];
    }
    if (runLine) {
      return [{ line: runLine, message: test.nodeLog?.error?.message ?? 'this line failed' }];
    }
    return [];
  }, [check, runLine, test.nodeLog]);

  return (
    <Modal title={`Edit ${node.data?.label ?? 'step'}`} onClose={onClose} wide>
      <div className="workbench">
        <section className="workbench-io" aria-label="What this step receives">
          <h3 className="workbench-heading">What it receives</h3>
          <VariablePalette
            sources={sources}
            onInsert={(reference) => {
              // The editor registers a real insert handle while focused, so the
              // chip lands at the cursor even though this modal is portalled
              // outside the panel the DOM path looks in. Falling back to the
              // clipboard keeps the reference reachable if focus is elsewhere.
              const insert = activeInsertHandle();
              if (insert) {
                insert(reference);
                return;
              }
              navigator.clipboard?.writeText(reference)?.catch(() => undefined);
              toast.info('Reference copied - click into the code to insert it directly');
            }}
          />
        </section>

        <section className="workbench-code" aria-label="The code">
          <CodeEditor
            id="workbench-code"
            ariaLabel="Code"
            value={value}
            onChange={(next) => flow.updateConfigField(node.id, field, next === '' ? undefined : next)}
            language={language}
            minLines={16}
            maxLines={28}
            markers={markers}
          />
        </section>

        <section className="workbench-run" aria-label="Test this step">
          <label className="field-label" htmlFor="workbench-input">
            Sample input
          </label>
          <p className="help">
            Stands in for the data an earlier step would pass. It arrives in your code as
            <code> input</code>.
          </p>
          <textarea
            id="workbench-input"
            className="mono"
            rows={3}
            value={input}
            aria-label="Sample input JSON"
            onChange={(event) => setInput(event.target.value)}
          />
          <div className="workbench-actions">
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => void validate(value)}
              disabled={checking || value.trim() === ''}
            >
              {checking ? 'Checking' : 'Validate'}
            </button>
            {check && (
              <span className={check.ok ? 'check-ok' : 'check-bad'} role="status">
                {check.ok ? 'Parses' : verdictText(check)}
              </span>
            )}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              // The hook owns its own failures and surfaces them in `message`;
              // nothing here needs the promise.
              test.run(input).catch(() => undefined);
            }}
            disabled={test.phase === 'running'}
          >
            {test.phase === 'running' ? 'Running' : 'Run this step'}
          </button>

          {test.message && (
            <p className="field-error" role="alert">
              {test.message}
            </p>
          )}
          {test.status && (
            <div className="test-result">
              <div className="test-status">
                <span className={`run-dot status-${test.status}`} aria-hidden="true" />
                Run {test.status}
              </div>
              {test.nodeLog?.output !== undefined && (
                <pre className="mono test-output">{stringify(test.nodeLog.output)}</pre>
              )}
              {test.nodeLog?.error && (
                <pre className="mono test-output test-output-error">
                  {test.nodeLog.error.message ?? stringify(test.nodeLog.error)}
                </pre>
              )}
            </div>
          )}
        </section>

        <section className="workbench-io" aria-label="What this step passes on">
          <h3 className="workbench-heading">What it passes on</h3>
          <OutputsPanel node={node} entry={entry} />
        </section>
      </div>
    </Modal>
  );
}
