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
 * Every compose/*.yml is read, not just the hero one, and a file the
 * gate cannot parse is itself a violation: silence is not a pass.
 *
 * The live docker compose boot itself runs in the e2e job; this gate
 * is the fast, always-on guard.
 */
import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const HERO_COMPOSE = 'docker-compose.yml';
// The overlays are layered ON the hero file (`-f docker-compose.yml -f ...`)
// and are documented as deliberately networked: Caddy fetches certificates,
// the sample databases are third-party images. So the offline topology rules
// belong to the hero stack alone. Every compose file is still read, and any
// compose file NOT named here gets the full hero treatment, so a new one is
// policed by default rather than by remembering to add it.
const OVERLAYS = new Set(['docker-compose.prod.yml', 'docker-compose.sample-db.yml']);

const ALLOWED_IMAGE_PREFIXES = ['temporalio/'];
const EXTERNAL_URL_PATTERN = /:\s*['"]?https?:\/\/(?!localhost|127\.0\.0\.1|temporal[:\s])/i;
// Short syntax is [BIND:]HOST:CONTAINER, so the host port is the second-to-last
// colon-separated number whatever precedes it: '5432:5432', '127.0.0.1:5432:5432'
// and '0.0.0.0:5432:5432' all publish 5432 to the host. Anchoring the bind
// address to 127.0.0.1 alone meant every other way of writing it went unseen.
const SHORT_PORT = /^\s*-\s*['"]?(?:[\w.-]+:)?(\d+):\d+(?:\/\w+)?['"]?\s*$/;
// The long syntax spells the same thing out.
const LONG_PORT = /published:\s*['"]?(\d+)/g;

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

function hostPorts(block) {
  const short = block
    .split('\n')
    .map((line) => SHORT_PORT.exec(line)?.[1])
    .filter(Boolean);
  return [...short, ...[...block.matchAll(LONG_PORT)].map((match) => match[1])];
}

function serviceViolations(file, name, block) {
  const violations = [];
  const blockLines = block.split('\n').map((line) => line.trim());
  const imageLine = blockLines.find((line) => line.startsWith('image:'));
  const hasBuild = blockLines.some((line) => line === 'build:' || line.startsWith('build:'));
  if (imageLine) {
    const image = imageLine.slice('image:'.length).trim();
    if (!ALLOWED_IMAGE_PREFIXES.some((prefix) => image.startsWith(prefix))) {
      violations.push({ file, rule: 'external-image', detail: `service "${name}" uses image "${image}"` });
    }
  } else if (!hasBuild) {
    violations.push({ file, rule: 'service-without-image-or-build', detail: `service "${name}"` });
  }
  if (EXTERNAL_URL_PATTERN.test(block)) {
    violations.push({ file, rule: 'external-egress', detail: `service "${name}" references an external URL` });
  }
  for (const hostPort of hostPorts(block)) {
    if (hostPort !== '3000' && hostPort !== '8233') {
      violations.push({
        file,
        rule: 'unexpected-published-port',
        detail: `service "${name}" publishes host port ${hostPort}`,
      });
    }
  }
  return violations;
}

export function runStandaloneBootGate(rootDir) {
  const composeDir = join(rootDir, 'compose');
  if (!existsSync(join(composeDir, HERO_COMPOSE))) {
    return [{ file: `compose/${HERO_COMPOSE}`, rule: 'compose-missing' }];
  }
  const violations = [];
  for (const entry of readdirSync(composeDir).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const file = `compose/${entry}`;
    const services = Object.entries(parseServices(readFileSync(join(composeDir, entry), 'utf8')));
    if (services.length === 0) {
      // The reader above is deliberately small, so it has blind spots: a
      // trailing comment on `services:`, four-space keys, an `x-` anchor block.
      // Every one of them used to yield zero services, zero services yielded
      // zero violations, and the gate reported success on a file it had never
      // read. A file it cannot parse is the violation instead, which turns the
      // next blind spot into a loud failure rather than a silent pass.
      violations.push({
        file,
        rule: 'compose-unparsed',
        detail: 'no services read, so nothing in this file was checked',
      });
      continue;
    }
    if (OVERLAYS.has(entry)) continue;
    violations.push(...services.flatMap(([name, block]) => serviceViolations(file, name, block)));
  }
  return violations;
}
