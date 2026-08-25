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
 * Monaco's web workers.
 *
 * Monaco asks the page for a worker and, given no answer, tries to fetch one
 * from a CDN - which the product must never do: Metis runs on machines with no
 * egress at all, and a silent CDN call is both a broken editor and an outbound
 * request nobody asked for.
 *
 * ONE worker, the editor's own. The language workers are deliberately absent:
 * their whole job is diagnostics, and those come from the engine instead (see
 * CodeEditor - the browser's idea of JavaScript disagrees with this sandbox,
 * and it has no idea about Python). Not shipping them is several megabytes we
 * do not pay for and a class of wrongness we do not show.
 *
 * `?worker` is Vite's own syntax: it emits the worker as a real asset with a
 * hashed .js name, which the production static route serves correctly.
 */
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker };
  }
}

export function installMonacoWorkers(): void {
  self.MonacoEnvironment = {
    getWorker() {
      return new EditorWorker();
    },
  };
}
