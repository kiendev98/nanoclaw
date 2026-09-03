/**
 * Delivery claims the thread it opens — and does not redirect into it.
 *
 * One of the three write-path halves of the session/thread binding. Storage
 * lives in `db/session-thread-binding.test.ts` and the inbound lookup in
 * `session-thread-routing.test.ts`. Here: a top-level post binds the thread
 * the channel created for it, so a human's reply can find the session that
 * spoke.
 *
 * There is deliberately no outbound counterpart. An earlier revision also
 * delivered a later thread-less message INTO the bound thread, which buried
 * every proactive post and question card a `shared` session ever made inside
 * the first thread it opened — see the tests below.
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
  // `now()`, not `datetime('now')`. The repo rule bans the SQLite form because
  // its naive `YYYY-MM-DD HH:MM:SS` shape has no `T` and no `Z`, so every
  // `new Date(row.timestamp)` in the codebase reads it as LOCAL time — a
  // silent offset shift, and an hour more of it across a DST boundary. A test
  // fixture is exactly where that convention rots first, because nothing here
  // reads the column back today.
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, 'chat', ?, 'slack', ?, ?)`,
  ).run(msgId, now(), AWAY_PLATFORM, threadId, JSON.stringify({ text: 'hello' }));
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

describe('a later thread-less message does NOT get pulled into the bound thread', () => {
  it('posts a second thread-less message at top level', async () => {
    // An earlier revision redirected it into the binding, which read as
    // "keep talking where you were talking". It is wrong for the sessions
    // that actually hit it: a `shared` session's `thread_id` is always null,
    // so EVERY later question card and proactive post inherited the first
    // thread it ever opened — permanently, since the binding is first-wins
    // with nothing that clears it.
    const session = await homeSession();
    insertOutbound(session.id, 'out-1');
    const threads: (string | null)[] = [];
    recordingAdapter(threads);

    await deliverSessionMessages(session);
    insertOutbound(session.id, 'out-2');
    await deliverSessionMessages(session);

    expect(threads).toEqual([null, null]);
  });

  it('leaves an explicitly addressed thread alone', async () => {
    // The container resolves a reply's thread from the last inbound on that
    // channel, and that route is untouched here — this asserts delivery does
    // not second-guess an address the agent already chose.
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

  it('keeps the first binding rather than re-pointing to a later post', async () => {
    // First-wins matters more now that a second top-level post is possible:
    // the thread people are already replying in must not lose its session to
    // whatever the agent posted most recently.
    const session = await homeSession();
    insertOutbound(session.id, 'out-1');
    recordingAdapter([]);
    await deliverSessionMessages(session);

    insertOutbound(session.id, 'out-2');
    await deliverSessionMessages(session);

    expect((await getSession(session.id))?.bound_root_message_id).toBe(ROOT);
  });
});
