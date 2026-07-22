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
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'site/**'],
  },
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  {
    rules: {
      'no-console': 'error',
      'no-eval': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Keep source files focused: a file past this cap is doing too many jobs.
    // Tests and fakes are exempt (suites and in-memory ports read fine long).
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
    ignores: ['**/__tests__/**', '**/fakes.ts'],
    rules: {
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'gates/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Conformance entry specs register their tests inside the imported
    // suite function, which static analysis cannot see.
    files: ['**/conformance.*.spec.ts'],
    rules: {
      'sonarjs/no-empty-test-file': 'off',
    },
  },
  {
    // Tests exercise local stubs, SSRF-blocked plain-http targets and
    // deliberately forged signatures; production policy lives in the
    // guards under test.
    files: ['**/__tests__/**/*.spec.ts'],
    rules: {
      'sonarjs/no-clear-text-protocols': 'off',
      'sonarjs/hardcoded-secret-signatures': 'off',
    },
  },
);
