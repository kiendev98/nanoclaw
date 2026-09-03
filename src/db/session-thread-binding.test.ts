/**
 * A session must answer inside the thread it opened.
 *
 * The bug this closes is silent by construction. An agent posts top level, the
 * channel turns that post into a thread, and a reply there matches no session:
 * `resolveSession` keys on (agent group, messaging group, thread), the thread
 * has never been seen, and a BRAND NEW session answers in a conversation it
 * knows nothing about — while the session that opened it is never told.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { sqliteRaw } from './drivers/sqlite.js';
import {
  bindSessionToThread,
  closeDb,
  composeThreadId,
  createAgentGroup,
  createMessagingGroup,
  createSession,
  findSessionBoundToThread,
  getSession,
  initSqliteTestDb,
  runMigrations,
  threadRootMessageId,
  updateSession,
} from './index.js';
import type { Session } from '../types.js';

const AG = 'ag-orch';
const MG = 'mg-ai-anya';
const OTHER_MG = 'mg-anya-and-saber';
const ROOT = '1788411969.598739';

function session(id: string, agentGroupId = AG): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: OTHER_MG,
    thread_id: 'slack:C0BU6RSGAGK:1788411244.437519',
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

beforeEach(async () => {
  const db = await initSqliteTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: AG,
    name: 'orchestrator',
    folder: 'orchestrator',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  // The two channels of the real case: the orchestrator's own chat, and the
  // one it posts INTO — where the thread gets opened.
  await createMessagingGroup({
    id: OTHER_MG,
    channel_type: 'slack',
    platform_id: 'slack:C0BU6RSGAGK',
    name: 'anya-and-saber',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  });
  await createMessagingGroup({
    id: MG,
    channel_type: 'slack',
    platform_id: 'slack:C0ACWUFB44F',
    name: 'ai-anya',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  });
});

afterEach(async () => {
  await closeDb();
});

describe('migration 028', () => {
  it('adds both binding columns as nullable and default-free', async () => {
    const db = await initSqliteTestDb();
    await runMigrations(db);
    const cols = sqliteRaw(db)
      .prepare(`SELECT name, "notnull", dflt_value FROM pragma_table_info('sessions') WHERE name LIKE 'bound_%'`)
      .all() as { name: string; notnull: number; dflt_value: unknown }[];
    expect(cols.map((c) => c.name).sort()).toEqual(['bound_messaging_group_id', 'bound_root_message_id']);
    // NULL must stay expressible — it is what "has opened no thread" means,
    // which is true of nearly every session.
    for (const col of cols) {
      expect(col.notnull).toBe(0);
      expect(col.dflt_value).toBeNull();
    }
  });

  it('runs on an install that already has the columns from a reverted branch', async () => {
    // The live case, reproduced exactly. A migration on a branch that was
    // later reverted added these same two columns. Installs that ran it still
    // CARRY the columns, while the `schema_version` row naming it is for a
    // migration this code no longer has — and the runner skips those rather
    // than failing. So this migration, under its own name, does run there,
    // against a table where the columns already exist.
    //
    // Deleting the row is what makes the migration pending again; running the
    // suite twice would not, because the second pass has nothing to do.
    const db = await initSqliteTestDb();
    await runMigrations(db);
    sqliteRaw(db).prepare('DELETE FROM schema_version WHERE name = ?').run('session-thread-bindings');

    await expect(runMigrations(db)).resolves.not.toThrow();

    const cols = sqliteRaw(db)
      .prepare(`SELECT name FROM pragma_table_info('sessions') WHERE name LIKE 'bound_%'`)
      .all() as { name: string }[];
    expect(cols).toHaveLength(2);
  });

  it('still fails loudly on a schema error that is not a duplicate column', async () => {
    // The idempotency guard is narrow on purpose: widening it to any ALTER
    // failure would turn a real schema error into a silent no-op.
    const db = await initSqliteTestDb();
    await runMigrations(db);
    await expect(
      Promise.resolve().then(() => sqliteRaw(db).prepare('ALTER TABLE nope ADD COLUMN x TEXT').run()),
    ).rejects.toThrow(/no such table/i);
  });
});

describe('parsing a thread id', () => {
  it('takes the root from after the LAST colon, because a platform id has its own', () => {
    expect(threadRootMessageId(`slack:C0ACWUFB44F:${ROOT}`)).toBe(ROOT);
  });

  it('round-trips with the composed form used on the reply path', () => {
    const platformId = 'slack:C0ACWUFB44F';
    expect(threadRootMessageId(composeThreadId(platformId, ROOT))).toBe(ROOT);
  });

  it('returns the whole string when there is no colon at all', () => {
    expect(threadRootMessageId(ROOT)).toBe(ROOT);
  });
});

describe('binding a session to the thread it opened', () => {
  it('records the binding and finds it again from an inbound root', async () => {
    await createSession(session('sess-a'));

    expect(await bindSessionToThread('sess-a', MG, ROOT)).toBe(true);

    const found = await findSessionBoundToThread(MG, ROOT);
    expect(found?.id).toBe('sess-a');
  });

  it('is invisible to a session that opened nothing', async () => {
    await createSession(session('sess-a'));
    expect(await findSessionBoundToThread(MG, ROOT)).toBeUndefined();
  });

  it('keeps the FIRST thread and refuses to be re-pointed', async () => {
    // A second top-level post must not silently steal the binding from the
    // thread people are already replying in.
    await createSession(session('sess-a'));
    await bindSessionToThread('sess-a', MG, ROOT);

    expect(await bindSessionToThread('sess-a', MG, '9999999999.000001')).toBe(false);

    expect((await getSession('sess-a'))?.bound_root_message_id).toBe(ROOT);
    expect((await findSessionBoundToThread(MG, ROOT))?.id).toBe('sess-a');
  });

  it('does not match the same root in a different channel', async () => {
    await createSession(session('sess-a'));
    await bindSessionToThread('sess-a', MG, ROOT);

    expect(await findSessionBoundToThread(OTHER_MG, ROOT)).toBeUndefined();
  });

  it('stops matching once the session closes, so the reply gets a live one', async () => {
    await createSession(session('sess-a'));
    await bindSessionToThread('sess-a', MG, ROOT);
    await updateSession('sess-a', { status: 'closed' });

    expect(await findSessionBoundToThread(MG, ROOT)).toBeUndefined();
  });

  it('stores the root in the form the inbound parser reads back', async () => {
    // `composeThreadId` and `threadRootMessageId` are inverses, and the stored
    // root is what has to survive the round trip. This replaces a test of the
    // deleted outbound reader; the property it was really pinning is this one.
    await createSession(session('sess-a'));
    await bindSessionToThread('sess-a', MG, ROOT);

    const stored = (await getSession('sess-a'))?.bound_root_message_id;
    expect(stored).toBe(ROOT);
    expect(composeThreadId('slack:C0ACWUFB44F', stored!)).toBe(`slack:C0ACWUFB44F:${ROOT}`);
  });

  it('gives two sessions in one channel their own threads', async () => {
    await createSession(session('sess-a'));
    await createSession({ ...session('sess-b'), thread_id: 'slack:C0BU6RSGAGK:1788411244.999999' });
    await bindSessionToThread('sess-a', MG, ROOT);
    await bindSessionToThread('sess-b', MG, '1788411970.111111');

    expect((await findSessionBoundToThread(MG, ROOT))?.id).toBe('sess-a');
    expect((await findSessionBoundToThread(MG, '1788411970.111111'))?.id).toBe('sess-b');
  });
});
