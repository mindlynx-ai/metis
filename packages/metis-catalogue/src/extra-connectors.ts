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
 * Wired HTTP connectors that live OUTSIDE the length-locked top-100
 * (connectors.v1.json is frozen at 100 by a drift test, so new ones cannot be
 * appended to it). Unlike the database connectors, these are ordinary HTTP
 * services with verified operations, so they get the FULL wired treatment: they
 * seed into the registry and generate a droppable node type, exactly like a
 * top-100 wired connector. Add a connector here when it is worth first-class
 * support but is not part of the frozen market list.
 */
import type { ConnectorCatalogueRecord } from './loader.js';

export const EXTRA_CONNECTORS: ConnectorCatalogueRecord[] = [
  {
    connectorId: 'resend',
    name: 'Resend',
    baseUrl: 'https://api.resend.com',
    authScheme: 'bearer',
    tier: 'open',
    category: 'communication',
    operations: [
      {
        name: 'sendEmail',
        method: 'POST',
        pathTemplate: '/emails',
        description: 'Send an email',
        // The email fields Resend's POST /emails receives; each becomes a
        // labelled body field in the inspector (the "what you receive" half).
        parameters: [
          {
            key: 'from',
            label: 'From',
            type: 'email',
            required: true,
            placeholder: 'You <you@your-domain.com>',
            description:
              'Must be an address on a domain you have verified in Resend. The recipient can be anywhere.',
          },
          { key: 'to', label: 'To', type: 'email', required: true, placeholder: 'recipient@example.com' },
          { key: 'subject', label: 'Subject', type: 'string', required: true },
          { key: 'html', label: 'Body (HTML)', type: 'text', description: 'HTML body. Provide this or a plain-text body.' },
          { key: 'text', label: 'Body (plain text)', type: 'text' },
          { key: 'cc', label: 'Cc', type: 'email' },
          { key: 'bcc', label: 'Bcc', type: 'email' },
          { key: 'reply_to', label: 'Reply-To', type: 'email' },
        ],
        // What the send gives back: Resend returns the new email's id.
        outputs: [{ key: 'id', label: 'Email ID', type: 'string', description: 'The id of the sent email.' }],
        wireStatus: 'verified',
      },
      {
        name: 'getEmail',
        method: 'GET',
        pathTemplate: '/emails/{emailId}',
        description: 'Retrieve a sent email',
        parameters: [
          { key: 'emailId', label: 'Email ID', type: 'string', required: true, description: 'The id returned when the email was sent.' },
        ],
        outputs: [
          { key: 'id', label: 'Email ID', type: 'string' },
          { key: 'from', label: 'From', type: 'string' },
          { key: 'to', label: 'To', type: 'array' },
          { key: 'subject', label: 'Subject', type: 'string' },
          { key: 'last_event', label: 'Last event', type: 'string', description: 'delivered, bounced, ...' },
          { key: 'created_at', label: 'Created at', type: 'string' },
        ],
        wireStatus: 'verified',
      },
    ],
    // Resend's root returns 200 for any bearer, so GET / cannot tell a good key
    // from a bad one. Probe POST /emails with an empty body instead: a valid key
    // gets a 422 (missing fields - nothing sent), a bad key gets 401.
    healthCheck: { method: 'POST', path: '/emails', body: {} },
    provenance: { source: 'resend-api-docs', licence: 'public' },
  },
];
