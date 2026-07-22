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
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@mindlynx/metis-ports': pkg('metis-ports'),
      '@mindlynx/metis-data-gateway': pkg('metis-data-gateway'),
      '@mindlynx/metis-engine': pkg('metis-engine'),
      '@mindlynx/metis-nodes': pkg('metis-nodes'),
      '@mindlynx/metis-catalogue': pkg('metis-catalogue'),
      '@mindlynx/metis-orchestrator': pkg('metis-orchestrator'),
      '@mindlynx/metis-core': pkg('metis-core'),
      '@mindlynx/metis-cli': pkg('metis-cli'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'packages/*/src/**/*.spec.ts', 'packages/*/tests/**/*.spec.ts'],
  },
});
