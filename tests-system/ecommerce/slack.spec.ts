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
 * Slack for real. Every other Slack assertion in this suite stops at a capture
 * server, which proves the flow called out but not that Slack accepted it.
 * These cases drive the shipped `slack` node against a real workspace: the
 * stored connection supplies the token, the declared operations supply the
 * shape, and the message lands in a channel a human can go and read.
 *
 * Configure with two environment variables and nothing in the repo:
 *
 *   METIS_SLACK_CONNECTION   the connection id holding the bot token
 *   METIS_SLACK_CHANNEL      the channel id to post in (the bot must be invited)
 *
 * Absent either, the file skips, so a fresh clone still runs green. The
 * channel id is deliberately NOT committed: it names a private workspace.
 *
 * Scopes needed: chat:write (post) and channels:read (read the membership).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, client, login, node, nodeId, runtimeUp } from '../harness.js';
import { cancelStragglers, outputOf, settled, startRun, until, type Api } from './shop.js';

const CONNECTION = process.env.METIS_SLACK_CONNECTION;
const CHANNEL = process.env.METIS_SLACK_CHANNEL;

const up = await runtimeUp();
const configured = Boolean(CONNECTION && CHANNEL);
const suite = up && configured ? describe : describe.skip;
if (!up) {
  // eslint-disable-next-line no-console
  console.warn(`[slack] no runtime at ${BASE}; skipping.`);
} else if (!configured) {
  // eslint-disable-next-line no-console
  console.warn('[slack] set METIS_SLACK_CONNECTION and METIS_SLACK_CHANNEL to run against a real workspace.');
}

/** What the http node hands downstream: the envelope, then Slack's own body. */
interface SlackReply {
  status?: number;
  data?: {
    ok?: boolean;
    error?: string;
    ts?: string;
    channel?: string;
    members?: string[];
    user_id?: string;
  };
}

/** One step on the shipped `slack` node type, authenticated by the connection. */
const slack = (config: Record<string, unknown>, label: string) =>
  node(nodeId(), 'slack', { connectionId: CONNECTION, ...config }, label);

const post = (params: Record<string, unknown>, label = 'post to Slack') =>
  slack({ operation: 'postMessage', params }, label);

suite('Slack, against a real workspace', () => {
  let api: Api;
  let wf: string;

  /** Run a one-node flow and hand back what Slack answered. */
  const ask = async (step: ReturnType<typeof slack>): Promise<SlackReply> => {
    const executionId = await startRun(api, wf, [step], []);
    const run = await until(api, executionId, settled, 40000);
    expect(run.meta.status).toBe('completed');
    return (outputOf(run.logs, step.id) ?? {}) as SlackReply;
  };

  beforeAll(async () => {
    api = client(await login());
    const created = await api<{ workflowId: string }>('POST', '/api/workflows', {
      name: `slack-live-${Date.now()}`,
      type: 'workflow',
      nodes: [node(nodeId(), 'code', { code: 'return { seeded: true };' }, 'seed')],
      edges: [],
    });
    wf = created.body.workflowId;
  });

  afterAll(async () => {
    await cancelStragglers(api);
  });

  it('SLACK-01 a reorder notification reaches a real channel', async () => {
    const reply = await ask(
      post({
        channel: CHANNEL,
        text: 'Reorder drafted: SKU-2 stock is 18, below the threshold of 20. PO for 50 units raised by Metis.',
      }),
    );
    // Slack answers 200 whatever happens, so `ok` is the real verdict.
    expect(reply.status).toBe(200);
    expect(reply.data?.ok).toBe(true);
    // The message id, which a later step threads its updates under.
    expect(reply.data?.ts).toMatch(/^\d+\.\d+$/);
  }, 60000);

  it('SLACK-02 names an actual person, resolved live from the channel membership', async () => {
    // Who the app itself is, so the humans can be told from the bot.
    const whoami = await ask(slack({ method: 'GET', path: '/auth.test' }, 'who am I'));
    const self = whoami.data?.user_id;
    expect(self).toMatch(/^U/);

    const membership = await ask(
      slack({ operation: 'listChannelMembers', params: { channel: CHANNEL } }, 'who is in here'),
    );
    expect(membership.data?.ok).toBe(true);
    const people = (membership.data?.members ?? []).filter((id) => id !== self);
    expect(people.length).toBeGreaterThan(0);

    // A real member of a real workspace, mentioned so they are actually notified.
    const mention = `<@${people[0]}>`;
    const reply = await ask(
      post({ channel: CHANNEL, text: `${mention} PO-1002 has had no acknowledgement for 24 hours.` }),
    );
    expect(reply.data?.ok).toBe(true);
  }, 90000);

  it('SLACK-03 a wrong channel is legible in the run record, not a silent success', async () => {
    // The trap this closes: Slack answers HTTP 200 for a refusal, and the http
    // node completes on any status. Without reading `ok`, a workflow author
    // would see a green run and no message.
    const reply = await ask(post({ channel: 'C000NOTREAL0', text: 'this should not arrive' }, 'bad channel'));
    expect(reply.status).toBe(200);
    expect(reply.data?.ok).toBe(false);
    expect(reply.data?.error).toBe('channel_not_found');
  }, 60000);

  it('SLACK-04 an optional parameter left out still makes a valid call', async () => {
    // `limit` is declared optional. The inspector must omit it rather than send
    // an empty one: Slack rejects `limit=` with "must provide a number".
    const listed = await ask(slack({ operation: 'listConversations', params: {} }, 'list channels'));
    expect(listed.data?.ok).toBe(true);

    // And a supplied optional threads the reply under the first message.
    const parent = await ask(post({ channel: CHANNEL, text: 'Supplier chase, thread follows.' }));
    const child = await ask(
      post({ channel: CHANNEL, text: 'Chased again, no response.', thread_ts: parent.data?.ts }, 'reply in thread'),
    );
    expect(child.data?.ok).toBe(true);
  }, 90000);
});
