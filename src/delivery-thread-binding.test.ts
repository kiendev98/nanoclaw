/**
 * Delivery claims the thread it opens, and keeps talking in it.
 *
 * The two write-path halves of the session/thread binding — the storage lives
 * in `db/session-thread-binding.test.ts` and the inbound lookup in
 * `session-thread-routing.test.ts`. Here: a top-level post binds the thread
 * the channel created for it (hook 1), and a later message with no thread of
 * its own is delivered INTO that thread rather than starting a second one
 * (hook 3).
 *
 * Only a root post may bind. A reply carries its own message id, which names
 * no thread — measured live, a reply into the thread rooted at `…925.613579`
 * came back as `1788370933.675069`. Binding on every delivery would store a
 * key no inbound thread can ever match, and would fail silently.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-delivery-binding';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-delivery-binding' };
});

import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';
import { resolveSession } from './session-manager.js';
import { outboundDbPath } from './mailbox/sqlite/paths.js';
import { closeDb, createAgentGroup, createMessagingGroup, getSession, initTestDb, runMigrations } from './db/index.js';
import { createDestination } from './modules/agent-to-agent/db/agent-destinations.js';

const AG = 'ag-1';
/** The session's own chat. */
const HOME_MG = 'mg-home';
/** The channel it posts INTO — where the thread gets opened. */
const AWAY_MG = 'mg-away';
const AWAY_PLATFORM = 'slack:C0ACWUFB44F';
const ROOT = '1788411969.598739';

function now(): string {
  return new Date().toISOString();
}

/** A message with no thread of its own — the shape that opens a thread. */
function insertOutbound(sessionId: string, msgId: string, threadId: string | null = null): void {
  const db = new Database(outboundDbPath(AG, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, datetime('now'), 'chat', ?, 'slack', ?, ?)`,
  ).run(msgId, AWAY_PLATFORM, threadId, JSON.stringify({ text: 'hello' }));
  db.close();
}

/** Records the thread id each delivery was addressed to. */
function recordingAdapter(threads: (string | null)[], rootId = ROOT) {
  setDeliveryAdapter({
    async deliver(_channelType, _platformId, threadId) {
      threads.push(threadId);
      // The channel answers with the posted message's own id. For a top-level
      // post that id IS the new thread's root.
      return threadId === null ? rootId : `${Date.now()}.000001`;
    },
  });
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: AG, name: 'Orchestrator', folder: 'orch', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: HOME_MG,
    channel_type: 'slack',
    platform_id: 'slack:C0BU6RSGAGK',
    name: 'home',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroup({
    id: AWAY_MG,
    channel_type: 'slack',
    platform_id: AWAY_PLATFORM,
    name: 'away',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  // Posting into a channel that is not the session's own needs an explicit
  // grant — the same row that makes the whole scenario possible in production.
  await createDestination({
    agent_group_id: AG,
    local_name: 'away',
    target_type: 'channel',
    target_id: AWAY_MG,
    created_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/** A session living in its own chat, as the orchestrator does. */
async function homeSession() {
  const { session } = await resolveSession(AG, HOME_MG, null, 'shared');
  return session;
}

describe('a top-level post claims the thread it opens', () => {
  it('binds the session to the delivered message id', async () => {
    const session = await homeSession();
    insertOutbound(session.id, 'out-1');
    recordingAdapter([]);

    await deliverSessionMessages(session);

    const after = await getSession(session.id);
    expect(after?.bound_messaging_group_id).toBe(AWAY_MG);
    expect(after?.bound_root_message_id).toBe(ROOT);
  });

  it('does NOT bind a message that already names a thread', async () => {
    // A reply's own id names no thread. Storing it would be a key nothing can
    // ever match, and nothing would report the mistake.
    const session = await homeSession();
    insertOutbound(session.id, 'out-1', `${AWAY_PLATFORM}:1788370925.613579`);
    recordingAdapter([]);

    await deliverSessionMessages(session);

    expect((await getSession(session.id))?.bound_root_message_id).toBeFalsy();
  });

  it('does not bind when the channel returns no message id', async () => {
    const session = await homeSession();
    insertOutbound(session.id, 'out-1');
    setDeliveryAdapter({
      async deliver() {
        return undefined;
      },
    });

    await deliverSessionMessages(session);

    expect((await getSession(session.id))?.bound_root_message_id).toBeFalsy();
  });
});

describe('later messages go into the thread, not beside it', () => {
  it('delivers a second thread-less message into the bound thread', async () => {
    const session = await homeSession();
    insertOutbound(session.id, 'out-1');
    const threads: (string | null)[] = [];
    recordingAdapter(threads);

    await deliverSessionMessages(session);
    insertOutbound(session.id, 'out-2');
    await deliverSessionMessages(session);

    // First opened the thread; second landed inside it.
    expect(threads).toEqual([null, `${AWAY_PLATFORM}:${ROOT}`]);
  });

  it('uses the binding written earlier in the SAME drain', async () => {
    // A drain loads its session once and then delivers several messages, so
    // the binding is read from the row rather than from that in-memory copy —
    // which is stale exactly when both messages ride the same batch.
    const session = await homeSession();
    insertOutbound(session.id, 'out-1');
    insertOutbound(session.id, 'out-2');
    const threads: (string | null)[] = [];
    recordingAdapter(threads);

    await deliverSessionMessages(session);

    expect(threads).toEqual([null, `${AWAY_PLATFORM}:${ROOT}`]);
  });

  it('leaves an explicitly addressed thread alone', async () => {
    const session = await homeSession();
    insertOutbound(session.id, 'out-1');
    const threads: (string | null)[] = [];
    recordingAdapter(threads);
    await deliverSessionMessages(session);

    const elsewhere = `${AWAY_PLATFORM}:1788370925.613579`;
    insertOutbound(session.id, 'out-2', elsewhere);
    await deliverSessionMessages(session);

    expect(threads[1]).toBe(elsewhere);
  });

  it('keeps the first thread rather than re-pointing to a later post', async () => {
    const session = await homeSession();
    insertOutbound(session.id, 'out-1');
    recordingAdapter([]);
    await deliverSessionMessages(session);

    insertOutbound(session.id, 'out-2');
    await deliverSessionMessages(session);

    expect((await getSession(session.id))?.bound_root_message_id).toBe(ROOT);
  });
});
