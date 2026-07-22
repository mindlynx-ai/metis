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

export type BusListener = (event: WorkflowEvent) => void;

/**
 * The local in-process event bus: an EventSink whose
 * events can be subscribed to by other open-build services (the
 * event-subscription trigger, the run-status WebSocket). Listener
 * failures are swallowed: the bus is fire-and-forget like every sink.
 */
export class LocalEventBus implements EventSink {
  private readonly listeners = new Set<BusListener>();

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: WorkflowEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // fire-and-forget: a listener failure never breaks execution
      }
    }
  }
}

/** Fan an event out to several sinks (stdout plus the bus, typically). */
export class CompositeEventSink implements EventSink {
  private readonly sinks: EventSink[];

  constructor(...sinks: EventSink[]) {
    this.sinks = sinks;
  }

  emit(event: WorkflowEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.emit(event);
      } catch {
        // fire-and-forget
      }
    }
  }
}
