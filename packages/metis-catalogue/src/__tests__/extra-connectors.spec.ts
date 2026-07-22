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
 * The extra wired connectors (Resend, ...): first-class HTTP connectors that
 * live outside the length-locked top-100 yet get the full treatment - served
 * in the connections UI, a droppable node type, and a valid record to seed.
 */
import { describe, it, expect } from 'vitest';
import {
  getConnectorCatalogue,
  listAllConnectors,
  connectorNodeTypes,
  connectorNodeTypeIds,
} from '../loader.js';
import { EXTRA_CONNECTORS } from '../extra-connectors.js';

describe('extra wired connectors', () => {
  it('are HTTP with verified operations and do not touch the frozen top-100', () => {
    expect(getConnectorCatalogue().connectors).toHaveLength(100);
    for (const c of EXTRA_CONNECTORS) {
      expect(new URL(c.baseUrl).protocol).toMatch(/^https?:$/);
      expect((c.operations ?? []).length).toBeGreaterThan(0);
    }
    // Resend ships as a first-class option.
    expect(EXTRA_CONNECTORS.map((c) => c.connectorId)).toContain('resend');
  });

  it('are served to the UI (dropdown + connections list)', () => {
    const all = listAllConnectors();
    const resend = all.find((c) => c.connectorId === 'resend');
    expect(resend).toMatchObject({ name: 'Resend', authScheme: 'bearer', baseUrl: 'https://api.resend.com' });
    // Still one id per record across the whole union.
    expect(new Set(all.map((c) => c.connectorId)).size).toBe(all.length);
  });

  it('declare the email fields sendEmail receives (the node type carries its own parameters)', () => {
    const resend = EXTRA_CONNECTORS.find((c) => c.connectorId === 'resend')!;
    const sendEmail = resend.operations!.find((o) => o.name === 'sendEmail')!;
    const params = sendEmail.parameters ?? [];
    const byKey = Object.fromEntries(params.map((p) => [p.key, p]));
    // What an email node receives: sender, recipient, subject, body, cc/bcc/reply-to.
    for (const key of ['from', 'to', 'subject', 'html', 'text', 'cc', 'bcc', 'reply_to']) {
      expect(byKey[key], `missing parameter ${key}`).toBeTruthy();
    }
    // The essentials are required; the body carries a textarea widget hint.
    expect(byKey.from!.required).toBe(true);
    expect(byKey.to!.required).toBe(true);
    expect(byKey.subject!.required).toBe(true);
    expect(byKey.html!.type).toBe('text');
    // getEmail's path token is declared too.
    const getEmail = resend.operations!.find((o) => o.name === 'getEmail')!;
    expect((getEmail.parameters ?? []).map((p) => p.key)).toContain('emailId');
  });

  it('declare what sendEmail gives back (the "what you give" half)', () => {
    const resend = EXTRA_CONNECTORS.find((c) => c.connectorId === 'resend')!;
    const sendEmail = resend.operations!.find((o) => o.name === 'sendEmail')!;
    // Resend's send returns the new email's id.
    expect((sendEmail.outputs ?? []).map((o) => o.key)).toEqual(['id']);
    const getEmail = resend.operations!.find((o) => o.name === 'getEmail')!;
    // Retrieving an email gives the whole envelope.
    expect((getEmail.outputs ?? []).map((o) => o.key)).toEqual(
      expect.arrayContaining(['id', 'from', 'to', 'subject']),
    );
  });

  it('generate a droppable node type with their operations', () => {
    const ids = connectorNodeTypeIds();
    expect(ids).toContain('resend');
    const node = connectorNodeTypes().find((entry) => entry.type === 'resend');
    expect(node?.handler_status).toBe('ready');
    const props = (node?.configSchema as { properties?: Record<string, { enum?: string[]; 'x-helix-widget'?: string }> })
      ?.properties ?? {};
    expect(props.operation?.enum ?? []).toContain('sendEmail');
    // The node binds a connection (a connectorRef scoped to resend), not a type.
    expect(props.connectorId?.['x-helix-widget']).toBe('connectorRef');
  });
});
