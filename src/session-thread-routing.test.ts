/**
 * A reply in a thread the agent opened must reach the session that opened it.
 *
 * This is the routing half of the binding — `db/session-thread-binding.test.ts`
 * covers the storage. The failure it closes is silent: the thread was created
 * by the channel moments ago in response to our own top-level post, so the
 * ordinary (agent group, messaging group, thread) key has never seen it and
 * `resolveSession` mints a new session. It answers with an empty transcript,
 * to people replying to something it never said, while the session that did
 * say it is never told.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-thread-routing' };
});

import { resolveSession } from './session-manager.js';
import {
  bindSessionToThread,
  closeDb,
  composeThreadId,
  createAgentGroup,
  createMessagingGroup,
  initTestDb,
  runMigrations,
} from './db/index.js';

const AG = 'ag-orch';
const OTHER_AG = 'ag-someone-else';
const MG = 'mg-ai-anya';
const PLATFORM = 'slack:C0ACWUFB44F';
const ROOT = '1788411969.598739';
/** What the router hands `resolveSession` when a human replies inside the thread. */
const INBOUND_THREAD = composeThreadId(PLATFORM, ROOT);

function group(id: string, folder: string) {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() };
}

beforeEach(async () => {
  fs.rmSync('/tmp/nanoclaw-test-thread-routing', { recursive: true, force: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup(group(AG, 'orchestrator'));
  await createAgentGroup(group(OTHER_AG, 'someone-else'));
  await createMessagingGroup({
    id: MG,
    channel_type: 'slack',
    platform_id: PLATFORM,
    name: 'ai-anya',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync('/tmp/nanoclaw-test-thread-routing', { recursive: true, force: true });
});

/** The session that posted into the channel and opened thread `ROOT`. */
async function openerBoundToThread(agentGroupId = AG) {
  const { session } = await resolveSession(agentGroupId, MG, null, 'shared');
  await bindSessionToThread(session.id, MG, ROOT);
  return session;
}

describe('a reply in a thread the agent opened', () => {
  it('reaches the session that opened it, rather than minting a new one', async () => {
    const opener = await openerBoundToThread();

    const { session, created } = await resolveSession(AG, MG, INBOUND_THREAD, 'per-thread');

    expect(session.id).toBe(opener.id);
    expect(created).toBe(false);
  });

  it('wins over the ordinary key, so the binding is checked first', async () => {
    // Bind an opener, then create the session the ordinary per-thread lookup
    // would have produced. The binding must still win — otherwise the fix is
    // order-dependent and fails the moment a stray session exists.
    const opener = await openerBoundToThread();
    await resolveSession(OTHER_AG, MG, INBOUND_THREAD, 'per-thread');

    const { session } = await resolveSession(AG, MG, INBOUND_THREAD, 'per-thread');

    expect(session.id).toBe(opener.id);
  });

  it('never hands one agent the other agent session', async () => {
    // Fan-out puts two agents in one chat. A thread root is only a key within
    // the agent group that owns the binding.
    await openerBoundToThread(AG);

    const { session, created } = await resolveSession(OTHER_AG, MG, INBOUND_THREAD, 'per-thread');

    expect(session.agent_group_id).toBe(OTHER_AG);
    expect(created).toBe(true);
  });

  it('creates a session as before for a thread nobody opened', async () => {
    await openerBoundToThread();

    const { session, created } = await resolveSession(
      AG,
      MG,
      composeThreadId(PLATFORM, '9999999999.000001'),
      'per-thread',
    );

    expect(created).toBe(true);
    expect(session.thread_id).toBe(composeThreadId(PLATFORM, '9999999999.000001'));
  });

  it('leaves an unbound install exactly as it was', async () => {
    // Nothing bound anywhere: the lookup must be a no-op, not a behaviour change.
    const first = await resolveSession(AG, MG, INBOUND_THREAD, 'per-thread');
    const second = await resolveSession(AG, MG, INBOUND_THREAD, 'per-thread');

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.session.id).toBe(first.session.id);
  });
});
