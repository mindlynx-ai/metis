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
 * Launch and supervise the Temporal dev server. Starts
 * `temporal server start-dev` with a persistent SQLite history file so
 * runs survive restarts (the run viewer's Temporal link depends on
 * it), probes readiness over the gRPC frontend port, writes a pidfile
 * and shuts down cleanly.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DevServerOptions {
  binaryPath: string;
  grpcPort: number;
  uiPort: number;
  databaseFile: string;
  pidFile: string;
  namespace?: string;
}

export function devServerArgs(options: DevServerOptions): string[] {
  return [
    'server',
    'start-dev',
    '--port',
    String(options.grpcPort),
    '--ui-port',
    String(options.uiPort),
    '--db-filename',
    options.databaseFile,
    '--namespace',
    options.namespace ?? 'default',
    '--log-level',
    'error',
  ];
}

export async function waitForPort(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 30_000,
  sleepMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket: Socket = connect({ port, host }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.setTimeout(sleepMs, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
  throw new Error(`Temporal dev server did not open port ${port} within ${timeoutMs}ms`);
}

export class TemporalDevServer {
  private child: ChildProcess | undefined;

  constructor(private readonly options: DevServerOptions) {}

  async start(): Promise<void> {
    mkdirSync(dirname(this.options.databaseFile), { recursive: true });
    mkdirSync(dirname(this.options.pidFile), { recursive: true });
    this.child = spawn(this.options.binaryPath, devServerArgs(this.options), {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (this.child.pid !== undefined) {
      writeFileSync(this.options.pidFile, String(this.child.pid));
    }
    this.child.on('exit', () => {
      rmSync(this.options.pidFile, { force: true });
    });
    await waitForPort(this.options.grpcPort);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      rmSync(this.options.pidFile, { force: true });
      return;
    }
    await new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 5_000);
    });
    rmSync(this.options.pidFile, { force: true });
  }
}

/** Default paths under a project's .metis directory. */
export function defaultDevServerPaths(projectDir: string): { databaseFile: string; pidFile: string } {
  return {
    databaseFile: join(projectDir, '.metis', 'temporal.db'),
    pidFile: join(projectDir, '.metis', 'temporal.pid'),
  };
}
