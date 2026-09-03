/**
 * The two doors a worker has to the agent that spawned it, and the one it
 * must not use.
 *
 * A worker reports by writing ordinary text: the runner holds it in
 * `pendingLaneReport`, supersedes it each turn, and delivers the last one when
 * the stream closes. `send_message({to:"parent"})` bypassed all of that —
 * immediate, and once per call. A real run sent three reports for one task.
 *
 * The row it addressed is NOT the mistake and is deliberately still there: the
 * runner's automatic report is routed by code and must pass `a2a.send`, which
 * denies any pair with no destination row. Only the NAME is withdrawn, and
 * only for a session on the agent lane.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { PROGRESS_PREFIX, reportProgress, sendMessage } from './core.js';

const ORCHESTRATOR = 'ag-orchestrator';

function seedSessionRouting(channelType: string | null, platformId: string | null): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  db.prepare(
    'INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, NULL)',
  ).run(channelType, platformId);
}

function seedDestination(name: string, agentGroupId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'agent', NULL, NULL, ?)`,
    )
    .run(name, name, agentGroupId);
}

function seedChannelDestination(name: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', 'slack', ?, NULL)`,
    )
    .run(name, name, platformId);
}

function textOf(index = 0): string {
  return JSON.parse(getUndeliveredMessages()[index].content).text;
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_message refuses the orchestrator, from a worker only', () => {
  it('refuses the destination that names the agent this worker answers to', async () => {
    seedSessionRouting('agent', ORCHESTRATOR);
    seedDestination('parent', ORCHESTRATOR);

    const res = await sendMessage.handler({ to: 'parent', text: 'status update' });

    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('names both replacements in the refusal, because a bare refusal leaves the need with no outlet', async () => {
    seedSessionRouting('agent', ORCHESTRATOR);
    seedDestination('parent', ORCHESTRATOR);

    const res = await sendMessage.handler({ to: 'parent', text: 'status update' });

    const text = res.content[0].text;
    expect(text).toContain('report_progress');
    expect(text).toContain('ask_user_question');
  });

  it('refuses by TARGET, not by the name "parent" — a renamed row is the same door', async () => {
    // `provision-agent.ts` mints `parent-2`, `parent-3`… on collision, so a
    // name check would miss exactly the groups that already had one.
    seedSessionRouting('agent', ORCHESTRATOR);
    seedDestination('parent-2', ORCHESTRATOR);

    const res = await sendMessage.handler({ to: 'parent-2', text: 'status update' });

    expect(res.isError).toBe(true);
  });

  it('still allows a PEER agent — only the orchestrator is withdrawn', async () => {
    seedSessionRouting('agent', ORCHESTRATOR);
    seedDestination('parent', ORCHESTRATOR);
    seedDestination('sibling', 'ag-sibling');

    const res = await sendMessage.handler({ to: 'sibling', text: 'hello' });

    expect(res.isError).toBeUndefined();
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('still allows a lent CHANNEL — a worker drives its own review thread', async () => {
    seedSessionRouting('agent', ORCHESTRATOR);
    seedChannelDestination('ai-anya', 'slack:C0AC');

    const res = await sendMessage.handler({ to: 'ai-anya', text: 'please review' });

    expect(res.isError).toBeUndefined();
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  /**
   * The scope that matters. `workerOrchestratorGroup` returns null unless BOTH
   * `workspace_path` and `origin_session_id` are set, and `create_agent` leaves
   * both NULL — so a companion never routes as `channel_type: 'agent'` and has
   * no automatic report. `parent` is its only way to reach its creator, and
   * refusing it there would cut it off entirely.
   */
  it('leaves a create_agent companion alone: no lane means parent is its ONLY door', async () => {
    seedSessionRouting('slack', 'slack:C0BU');
    seedDestination('parent', ORCHESTRATOR);

    const res = await sendMessage.handler({ to: 'parent', text: 'status update' });

    expect(res.isError).toBeUndefined();
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('leaves a session with no routing at all alone — neither lane, so nothing to withdraw', async () => {
    seedSessionRouting(null, null);
    seedDestination('parent', ORCHESTRATOR);

    const res = await sendMessage.handler({ to: 'parent', text: 'status update' });

    expect(res.isError).toBeUndefined();
  });
});

describe('report_progress — the door that replaces it', () => {
  it('writes to the lane without naming a destination', async () => {
    seedSessionRouting('agent', ORCHESTRATOR);

    const res = await reportProgress.handler({ text: 'CodeRabbit is re-reviewing; waiting.' });

    expect(res.isError).toBeUndefined();
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('agent');
    expect(out[0].platform_id).toBe(ORCHESTRATOR);
  });

  it('marks the text, so the orchestrator can tell a progress note from the answer', async () => {
    seedSessionRouting('agent', ORCHESTRATOR);

    await reportProgress.handler({ text: 'CodeRabbit is re-reviewing; waiting.' });

    const text = textOf();
    expect(text.startsWith(PROGRESS_PREFIX)).toBe(true);
    expect(text).toContain('CodeRabbit is re-reviewing; waiting.');
  });

  it('carries the marker in the TEXT, because the formatter renders content.text and drops the rest', async () => {
    seedSessionRouting('agent', ORCHESTRATOR);

    await reportProgress.handler({ text: 'note' });

    expect(Object.keys(JSON.parse(getUndeliveredMessages()[0].content))).toEqual(['text']);
  });

  it('refuses on a channel session, which has send_message and a human to address', async () => {
    seedSessionRouting('slack', 'slack:C0BU');

    const res = await reportProgress.handler({ text: 'note' });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('send_message');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('refuses empty text rather than writing an empty row', async () => {
    seedSessionRouting('agent', ORCHESTRATOR);

    const res = await reportProgress.handler({ text: '   ' });

    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('does not supersede: two notes are two messages, unlike the held report', async () => {
    seedSessionRouting('agent', ORCHESTRATOR);

    await reportProgress.handler({ text: 'first' });
    await reportProgress.handler({ text: 'second' });

    expect(getUndeliveredMessages()).toHaveLength(2);
  });
});

/**
 * A worker replying into the thread it opened.
 *
 * The host binds a session to the thread its first top-level post created, and
 * until now that binding was readable only by the host: it routed a human's
 * reply IN, and the container had no way to learn where to reply OUT. So a
 * second post named no thread and opened a SECOND root — and hook 1 being
 * first-wins, that root never bound, so every reply in it was lost.
 *
 * The binding now rides the destination map (`write-destinations.ts`), which is
 * rewritten on every wake.
 */
describe('a worker replies into the thread it opened', () => {
  function seedBoundChannel(name: string, platformId: string, threadId: string | null): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id, thread_id)
         VALUES (?, ?, 'channel', 'slack', ?, NULL, ?)`,
      )
      .run(name, name, platformId, threadId);
  }

  it('threads into its bound thread before anyone has replied', async () => {
    // The gap that broke the protocol: with no inbound on that channel yet,
    // `getLatestInboundRoute` has nothing to offer and the post went
    // top-level, opening a rival root.
    seedSessionRouting('agent', ORCHESTRATOR);
    seedBoundChannel('ai-anya', 'slack:C0ANYA', 'slack:C0ANYA:111.1');

    await sendMessage.handler({ to: 'ai-anya', text: 'PR #42 is ready for review' });

    const [out] = getUndeliveredMessages();
    expect(out.thread_id).toBe('slack:C0ANYA:111.1');
    expect(out.platform_id).toBe('slack:C0ANYA');
  });

  it('still posts top-level when it has opened no thread there', async () => {
    // A worker's FIRST post has to open the thread, so a null binding must
    // stay null — otherwise there is nothing for the host to bind to.
    seedSessionRouting('agent', ORCHESTRATOR);
    seedBoundChannel('ai-anya', 'slack:C0ANYA', null);

    await sendMessage.handler({ to: 'ai-anya', text: 'PR #42 is ready for review' });

    const [out] = getUndeliveredMessages();
    expect(out.thread_id).toBeNull();
  });

  it('keeps its own thread when another conversation is newer on that channel', async () => {
    // The binding wins over a newer inbound, and both doors agree on that.
    // A lent channel carries other people's threads; following whichever is
    // newest is how a considered answer lands in a stranger's conversation.
    seedSessionRouting('agent', ORCHESTRATOR);
    seedBoundChannel('ai-anya', 'slack:C0ANYA', 'slack:C0ANYA:111.1');
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
         VALUES ('in-1', 'chat', datetime('now'), 'pending', 'slack:C0ANYA', 'slack', 'slack:C0ANYA:222.2', ?)`,
      )
      .run(JSON.stringify({ sender: 'Someone else', text: 'unrelated thread' }));

    await sendMessage.handler({ to: 'ai-anya', text: 'thanks' });

    const [out] = getUndeliveredMessages();
    expect(out.thread_id).toBe('slack:C0ANYA:111.1');
  });
});
