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
import type { EventSink, WorkflowEvent } from '../event-sink.js';

type LineWriter = (line: string) => void;

const defaultWriter: LineWriter = (line) => {
  process.stdout.write(`${line}\n`);
};

/**
 * The open default EventSink: one structured JSON line per
 * lifecycle event, fire-and-forget. A sink failure must never reach the
 * engine, so writer errors are swallowed.
 */
export class StdoutEventSink implements EventSink {
  constructor(private readonly write: LineWriter = defaultWriter) {}

  emit(event: WorkflowEvent): void {
    try {
      this.write(JSON.stringify(event));
    } catch {
      // fire-and-forget: an observability failure never breaks execution
    }
  }
}
