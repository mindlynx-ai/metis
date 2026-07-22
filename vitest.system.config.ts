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
 * System integration suite, kept OUT of the default vitest
 * include so `npm test` stays hermetic. This suite drives a live `metis up`
 * runtime over HTTP (default http://localhost:3000, override with METIS_URL)
 * and skips itself gracefully when the runtime is not reachable. Run with
 * `npm run test:system`.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests-system/**/*.spec.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Executions are async on Temporal; keep it sequential and unflaky.
    fileParallelism: false,
  },
});
