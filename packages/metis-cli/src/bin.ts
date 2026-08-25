#!/usr/bin/env node
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
import { loadProjectEnv, runCli } from './cli.js';

// Before anything reads process.env. Every setting Metis has is read downstream
// of runCli, so this is the one place a project .env has to land.
loadProjectEnv(process.cwd());

// A configuration refusal is a message, not a crash. Without this, the very
// first command a newcomer runs answers a misconfiguration with a V8 stack
// trace into dist/, which buries the sentence that tells them what to set.
// ponytail: only the message survives here - a genuine internal fault loses its
// stack unless METIS_DEBUG is set, which is the trade a CLI wants.
try {
  const code = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
  process.exit(code);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  if (process.env.METIS_DEBUG === 'true' && error instanceof Error) {
    process.stderr.write(`${error.stack ?? ''}\n`);
  }
  process.exit(1);
}
