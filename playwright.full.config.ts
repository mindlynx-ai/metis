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
import { defineConfig } from '@playwright/test';

/**
 * The browser-driven top-to-bottom run. Boots a real runtime
 * (Temporal dev server plus worker) beside the editor and drives the
 * whole build-and-run flow in a real browser. Kept separate from the
 * fast dev-core config because it downloads and runs Temporal.
 */
export default defineConfig({
  testDir: './packages/metis-editor/e2e-full',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 120_000,
  use: { viewport: { width: 1440, height: 900 } },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: 'npx tsx packages/metis-editor/e2e-full/full-core.ts',
      port: 4181,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'npm run dev --workspace @mindlynx/metis-editor',
      port: 4180,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
