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
 * Search keywords for a node type - so the picker scales past a name match. We
 * tokenise the connector name and its operations (postMessage -> post, message)
 * plus the category, then expand a few synonym groups so a user's plain word
 * ("email") finds the providers whose operations say "mail" (SendGrid) or whose
 * name contains it (Gmail), without dragging in unrelated apps (Slack).
 */

export function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

/**
 * Each group: if a derived token contains any `root`, add the group's `terms`.
 * Roots are chosen to be safe as substrings (e.g. "mail" matches gmail/mailjet
 * but nothing unrelated); avoid bare two-letter roots that appear inside other
 * words (an "ai" root would wrongly match "email").
 */
const SYNONYM_GROUPS: { roots: string[]; terms: string[] }[] = [
  { roots: ['email', 'mail', 'smtp', 'inbox'], terms: ['email', 'mail'] },
  { roots: ['twilio', 'sms'], terms: ['sms', 'text'] },
  { roots: ['slack', 'discord', 'telegram', 'matrix', 'message', 'conversation', 'chat'], terms: ['chat', 'message'] },
  { roots: ['postgres', 'mysql', 'mongo', 'database', 'query', 'sql'], terms: ['database', 'sql'] },
  { roots: ['calendar', 'meeting', 'event'], terms: ['calendar'] },
  { roots: ['stripe', 'invoice', 'charge', 'checkout', 'payment', 'refund'], terms: ['payment', 'billing'] },
  { roots: ['openai', 'anthropic', 'claude', 'gemini', 'gpt', 'llm', 'embedding', 'completion'], terms: ['ai', 'llm'] },
];

export function deriveKeywords(
  name: string,
  category: string | undefined,
  operationNames: string[],
): string[] {
  const tokens = new Set<string>();
  for (const token of tokenize(name)) tokens.add(token);
  for (const op of operationNames) for (const token of tokenize(op)) tokens.add(token);
  if (category) for (const token of tokenize(category)) tokens.add(token);

  const seen = [...tokens];
  for (const group of SYNONYM_GROUPS) {
    if (seen.some((token) => group.roots.some((root) => token.includes(root)))) {
      for (const term of group.terms) tokens.add(term);
    }
  }
  return [...tokens];
}
