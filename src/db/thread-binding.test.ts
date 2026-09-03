/**
 * Thread binding: how a reply finds the session that opened the thread.
 *
 * Measured against a live install on 2026-09-03, which is where the two
 * constants below come from:
 *
 *   session_routing.thread_id     = slack:C0BU6RSGAGK:1788370925.613579
 *   delivered.platform_message_id = 1788370933.675069
 *
 * The delivered id is a BARE timestamp and the thread id is
 * `<platform_id>:<ts>`. Matching therefore parses; it never rebuilds the
 * prefix, because the format belongs to the Chat SDK and a wrong guess fails
 * by silently never matching.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from './index.js';
import { createMessagingGroup } from './messaging-groups.js';
import {
  composeThreadId,
  createSession,
  findSessionBoundToThread,
  threadRootMessageId,
  updateSession,
} from './sessions.js';
import type { Session } from '../types.js';

const AG = 'ag-bind';
const MG = 'mg-anya';
const PLATFORM = 'slack:C0BU6RSGAGK';
const ROOT_TS = '1788370925.613579';
const REPLY_TS = '1788370933.675069';

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: `system:tasks:${id}`,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: AG,
    name: 'binder',
    folder: 'binder',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
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

afterEach(() => {
  closeDb();
});

describe('threadRootMessageId', () => {
  it('takes the last segment, which is the only part that is an id', () => {
    expect(threadRootMessageId(`${PLATFORM}:${ROOT_TS}`)).toBe(ROOT_TS);
  });

  it('survives a platform id that itself contains colons', () => {
    expect(threadRootMessageId('slack:instance:C123:99.5')).toBe('99.5');
  });

  it('round-trips with composeThreadId', () => {
    expect(threadRootMessageId(composeThreadId(PLATFORM, ROOT_TS))).toBe(ROOT_TS);
  });
});

describe('findSessionBoundToThread', () => {
  it('finds the session that claimed the thread', async () => {
    await createSession(session('sess-owner'));
    await updateSession('sess-owner', {
      bound_messaging_group_id: MG,
      bound_root_message_id: ROOT_TS,
    });

    const found = await findSessionBoundToThread(MG, threadRootMessageId(`${PLATFORM}:${ROOT_TS}`));

    expect(found?.id).toBe('sess-owner');
  });

  it('does not match a reply timestamp, which names no thread', async () => {
    // The bug this guards: binding on any delivery rather than only a root
    // post stores a reply's own ts, which no inbound thread id ever carries.
    await createSession(session('sess-owner'));
    await updateSession('sess-owner', {
      bound_messaging_group_id: MG,
      bound_root_message_id: ROOT_TS,
    });

    expect(await findSessionBoundToThread(MG, REPLY_TS)).toBeUndefined();
  });

  it('stops matching once the session closes, so the binding needs no cleanup job', async () => {
    await createSession(session('sess-owner'));
    await updateSession('sess-owner', {
      bound_messaging_group_id: MG,
      bound_root_message_id: ROOT_TS,
    });
    await updateSession('sess-owner', { status: 'closed' });

    expect(await findSessionBoundToThread(MG, ROOT_TS)).toBeUndefined();
  });

  it('scopes the match to the messaging group', async () => {
    await createSession(session('sess-owner'));
    await updateSession('sess-owner', {
      bound_messaging_group_id: MG,
      bound_root_message_id: ROOT_TS,
    });

    expect(await findSessionBoundToThread('mg-elsewhere', ROOT_TS)).toBeUndefined();
  });
});
