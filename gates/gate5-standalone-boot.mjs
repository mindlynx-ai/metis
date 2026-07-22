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
 * Gate 5: the standalone-boot topology check. The hero compose
 * stack must run a workflow end to end with no network beyond the
 * local Temporal dev server. This gate statically enforces that
 * property so a violation cannot merge:
 *
 *   - the only images are the pinned official Temporal image and the
 *     locally-built Metis image (no third-party service pulled in);
 *   - the Metis service builds from the local Dockerfile, never a
 *     registry image;
 *   - no service declares an external URL environment variable that
 *     would reach outside the compose network;
 *   - only the editor port (3000) and the Temporal Web UI (8233,
 *     localhost-bound) are published to the host.
 *
 * The live docker compose boot itself runs in the e2e job; this gate
 * is the fast, always-on guard.
 */
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const ALLOWED_IMAGE_PREFIXES = ['temporalio/'];
const EXTERNAL_URL_PATTERN = /:\s*['"]?https?:\/\/(?!localhost|127\.0\.0\.1|temporal[:\s])/i;

function parseServices(yaml) {
  // A deliberately small YAML reader for the two-space-indented compose
  // shape we author; it extracts each service block as raw text.
  const lines = yaml.split('\n');
  const services = {};
  let inServices = false;
  let current;
  let buffer = [];
  const flush = () => {
    if (current) services[current] = buffer.join('\n');
    buffer = [];
  };
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (inServices && /^\S/.test(line)) {
      flush();
      inServices = false;
      current = undefined;
      continue;
    }
    if (inServices) {
      const service = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
      if (service) {
        flush();
        current = service[1];
      } else if (current) {
        buffer.push(line);
      }
    }
  }
  flush();
  return services;
}

function serviceViolations(name, block) {
  const violations = [];
  const blockLines = block.split('\n').map((line) => line.trim());
  const imageLine = blockLines.find((line) => line.startsWith('image:'));
  const hasBuild = blockLines.some((line) => line === 'build:' || line.startsWith('build:'));
  if (imageLine) {
    const image = imageLine.slice('image:'.length).trim();
    if (!ALLOWED_IMAGE_PREFIXES.some((prefix) => image.startsWith(prefix))) {
      violations.push({
        file: 'compose/docker-compose.yml',
        rule: 'external-image',
        detail: `service "${name}" uses image "${image}"`,
      });
    }
  } else if (!hasBuild) {
    violations.push({
      file: 'compose/docker-compose.yml',
      rule: 'service-without-image-or-build',
      detail: `service "${name}"`,
    });
  }
  if (EXTERNAL_URL_PATTERN.test(block)) {
    violations.push({
      file: 'compose/docker-compose.yml',
      rule: 'external-egress',
      detail: `service "${name}" references an external URL`,
    });
  }
  const ports = [...block.matchAll(/-\s*['"]?(?:127\.0\.0\.1:)?(\d+):(\d+)['"]?/g)].map((match) => match[1]);
  for (const hostPort of ports) {
    if (hostPort !== '3000' && hostPort !== '8233') {
      violations.push({
        file: 'compose/docker-compose.yml',
        rule: 'unexpected-published-port',
        detail: `service "${name}" publishes host port ${hostPort}`,
      });
    }
  }
  return violations;
}

export function runStandaloneBootGate(rootDir) {
  const composePath = join(rootDir, 'compose', 'docker-compose.yml');
  if (!existsSync(composePath)) {
    return [{ file: 'compose/docker-compose.yml', rule: 'compose-missing' }];
  }
  const yaml = readFileSync(composePath, 'utf8');
  const services = parseServices(yaml);
  const violations = Object.entries(services).flatMap(([name, block]) => serviceViolations(name, block));
  return violations;
}
