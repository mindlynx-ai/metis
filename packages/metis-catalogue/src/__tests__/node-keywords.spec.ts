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
import { describe, it, expect } from 'vitest';
import { tokenize, deriveKeywords } from '../node-keywords.js';

describe('tokenize', () => {
  it('splits camelCase and punctuation into lowercase tokens', () => {
    expect(tokenize('sendEmail')).toEqual(['send', 'email']);
    expect(tokenize('SendGrid')).toEqual(['send', 'grid']);
    expect(tokenize('postMessage')).toEqual(['post', 'message']);
    expect(tokenize('ai-agent-tool')).toEqual(['ai', 'agent', 'tool']);
  });
});

describe('deriveKeywords', () => {
  it('makes "email" find the mail providers - by operation, name, or synonym', () => {
    // Resend: operation says email.
    expect(deriveKeywords('Resend', 'communication', ['sendEmail'])).toContain('email');
    // SendGrid: operation says mail -> expands to email.
    expect(deriveKeywords('SendGrid', 'communication', ['sendMail'])).toContain('email');
    // Gmail: no operations, but the name contains "mail".
    expect(deriveKeywords('Gmail', 'communication', [])).toContain('email');
  });

  it('does NOT tag a chat app as email', () => {
    const slack = deriveKeywords('Slack', 'communication', ['postMessage', 'listConversations']);
    expect(slack).not.toContain('email');
    expect(slack).toContain('message'); // it is chat/message, though
  });

  it('carries the operation and name tokens for precise matches', () => {
    const kw = deriveKeywords('Slack', 'communication', ['postMessage']);
    expect(kw).toEqual(expect.arrayContaining(['slack', 'post', 'message', 'communication']));
  });

  it('tags a database connector without false email/ai matches', () => {
    const pg = deriveKeywords('Postgres', 'data-flow', ['runQuery']);
    expect(pg).toEqual(expect.arrayContaining(['database', 'sql']));
    expect(pg).not.toContain('email');
    expect(pg).not.toContain('ai');
  });
});
