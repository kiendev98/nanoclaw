/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 *
 * The stamp is published through session_state in outbound.db, not module
 * state — the MCP server runs as a separate stdio subprocess from the poll
 * loop, so it can only see the stamp through the shared DB. These tests seed
 * it the same way the poll-loop process does (a direct DB write) rather than
 * via any in-memory helper, so they exercise the real process boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendMessage } from './core.js';

/**
 * Publish the a2a reply stamp the way the poll loop does: a direct write to
 * session_state in outbound.db. `ageMs` back-dates updated_at to exercise the
 * staleness guard MCP tools apply when reading it.
 */
function publishInReplyTo(id: string, ageMs = 0): void {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('current_in_reply_to', id, updatedAt);
}

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps the batch in_reply_to (published via the DB) on outbound rows', async () => {
    publishInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // Nothing published to session_state — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('ignores a stale stamp left behind by a killed container', async () => {
    publishInReplyTo('inbound-msg-1', 60 * 60 * 1000); // an hour old

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

/**
 * Which thread a reply lands in, per lane.
 *
 * A session with no channel of its own compares as `channel_type: 'agent'`
 * against every channel destination, so the own-channel test can never match
 * and every reply used to go out top-level. In a channel the agent itself
 * opened that is a new thread per message, and the binding cannot repair it:
 * it is first-wins, so the first thread binds and every orphan after it stays
 * unbound.
 *
 * The regression guard is the other half. delivery.ts once redirected every
 * thread-less outbound into the session's bound thread, and it had to be
 * removed — a `shared`-mode session's thread_id is always null, so the first
 * thread it ever opened captured every later post for the session's life. A
 * session that owns a channel must therefore behave exactly as it did before.
 */
describe('send_message MCP tool — which thread a channel reply lands in', () => {
  const CHANNEL = 'slack:C0ACWUFB44F';
  const THREAD = 'slack:C0ACWUFB44F:1788370933.925613';
  const OTHER_CHANNEL = 'slack:C0OTHER';
  const OTHER_THREAD = 'slack:C0OTHER:1788370933.111111';

  /** The routing the host stamps at spawn — absent from the test schema. */
  function seedSessionRouting(channelType: string | null, platformId: string | null, threadId: string | null): void {
    const db = getInboundDb();
    db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      channel_type TEXT, platform_id TEXT, thread_id TEXT
    )`);
    db.prepare(
      'INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)',
    ).run(channelType, platformId, threadId);
  }

  /** A channel destination, as the host projects a granted one. */
  function seedChannelDestination(name: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT OR REPLACE INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ($name, $name, 'channel', 'slack', $platformId, NULL)`,
      )
      .run({ $name: name, $platformId: platformId });
  }

  /** A message that channel sent us, which is what carries the thread. */
  function seedInbound(platformId: string, threadId: string, id: string, seq: number): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, content, channel_type, platform_id, thread_id)
         VALUES ($id, $seq, 'chat', $timestamp, 'pending', $content, 'slack', $platformId, $threadId)`,
      )
      .run({
        $id: id,
        $seq: seq,
        $timestamp: new Date().toISOString(),
        $content: JSON.stringify({ text: 'a reply from the channel' }),
        $platformId: platformId,
        $threadId: threadId,
      });
  }

  /** The lane a repo worker sends on: the orchestrator's agent group. */
  function workerLane(): void {
    seedSessionRouting('agent', 'ag-orchestrator', null);
  }

  function sentThreadId(): string | null {
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    return out[0].thread_id;
  }

  it('keeps a granted channel conversation in one thread', async () => {
    // The worker opened the thread and Anya replied in it, so that reply is
    // the latest inbound from this channel and names the thread to answer in.
    workerLane();
    seedChannelDestination('team-chat', CHANNEL);
    seedInbound(CHANNEL, THREAD, 'in-1', 2);

    await sendMessage.handler({ to: 'team-chat', text: 'on it' });

    expect(sentThreadId()).toBe(THREAD);
  });

  it('opens the thread top-level when that channel has said nothing yet', async () => {
    // The first post of all. There is no thread to join, and inventing one
    // would address a conversation that does not exist.
    workerLane();
    seedChannelDestination('team-chat', CHANNEL);

    await sendMessage.handler({ to: 'team-chat', text: 'PR #42 is ready for review' });

    expect(sentThreadId()).toBeNull();
  });

  it('follows the newest inbound when that channel has said several things', async () => {
    workerLane();
    seedChannelDestination('team-chat', CHANNEL);
    seedInbound(CHANNEL, OTHER_THREAD, 'in-1', 2);
    seedInbound(CHANNEL, THREAD, 'in-2', 4);

    await sendMessage.handler({ to: 'team-chat', text: 'on it' });

    expect(sentThreadId()).toBe(THREAD);
  });

  it('still keeps its own thread when the session owns the channel', async () => {
    // Unchanged behaviour for an ordinary chat session replying to its own
    // conversation.
    seedSessionRouting('slack', CHANNEL, THREAD);
    seedChannelDestination('team-chat', CHANNEL);

    await sendMessage.handler({ to: 'team-chat', text: 'here you go' });

    expect(sentThreadId()).toBe(THREAD);
  });

  it('does not thread a chat session into another channel it has heard from', async () => {
    // THE REGRESSION GUARD. A session that owns a channel keeps today's
    // behaviour exactly: a cross-destination send starts a new conversation,
    // and the removed delivery.ts redirect must not return through this door.
    seedSessionRouting('slack', CHANNEL, THREAD);
    seedChannelDestination('other', OTHER_CHANNEL);
    seedInbound(OTHER_CHANNEL, OTHER_THREAD, 'in-1', 2);

    await sendMessage.handler({ to: 'other', text: 'a proactive note' });

    expect(sentThreadId()).toBeNull();
  });
});
