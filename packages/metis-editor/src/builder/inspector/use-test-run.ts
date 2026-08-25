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
 * Running ONE step with a sample input, and reporting what came back.
 *
 * Extracted from the Test tab so the workbench can run a step too. Copied
 * rather than shared, these two would drift - and the last time a testing
 * surface drifted from the thing it tested, the sample-input box quietly did
 * nothing for months.
 *
 * It runs the step as a one-node graph through the REAL engine: same Temporal,
 * same sandbox, same handler. What you see here is what a real run does.
 */
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type RunLog, type WorkflowNode } from '../../api.js';

export type TestPhase = 'idle' | 'running' | 'done' | 'error';

const POLL_LIMIT = 15;
const POLL_MS = 600;

export interface TestRun {
  phase: TestPhase;
  status?: string;
  nodeLog?: RunLog;
  message?: string;
  run(rawInput: string): Promise<void>;
}

/**
 * @param node - the step to run alone.
 * @param save - persists the workflow first and yields its id; a step cannot be
 *   run before the workflow it belongs to exists.
 */
export function useTestRun(node: WorkflowNode, save: () => Promise<string | undefined>): TestRun {
  const [phase, setPhase] = useState<TestPhase>('idle');
  const [status, setStatus] = useState<string>();
  const [nodeLog, setNodeLog] = useState<RunLog>();
  const [message, setMessage] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const poll = async (executionId: string, tries: number): Promise<void> => {
    try {
      const detail = await api.execution(executionId);
      setStatus(detail.meta.status);
      const mine = detail.logs.filter((entry) => entry.nodeId === node.id);
      const last = mine[mine.length - 1];
      if (last) setNodeLog(last);
      if (detail.meta.status !== 'running' || tries >= POLL_LIMIT) {
        setPhase('done');
        return;
      }
    } catch {
      // An execution that is not visible yet just means keep waiting.
    }
    timer.current = setTimeout(() => void poll(executionId, tries + 1), POLL_MS);
  };

  const run = async (rawInput: string): Promise<void> => {
    setMessage(undefined);
    setNodeLog(undefined);
    setStatus(undefined);
    let parsed: unknown = {};
    if (rawInput.trim() !== '') {
      try {
        parsed = JSON.parse(rawInput);
      } catch {
        setPhase('error');
        setMessage('Input must be valid JSON.');
        return;
      }
    }
    setPhase('running');
    try {
      const workflowId = await save();
      if (!workflowId) throw new ApiError(400, 'save the workflow first');
      const started = await api.startExecution({
        // This step ALONE, as a one-node graph - not the whole flow.
        workflowId,
        definition: { nodes: [node], edges: [] },
        input: parsed,
      });
      setStatus(started.status ?? 'running');
      void poll(started.executionId, 0);
    } catch (cause) {
      setPhase('error');
      setMessage(cause instanceof ApiError ? cause.message : 'could not start the test run');
    }
  };

  return { phase, status, nodeLog, message, run };
}
