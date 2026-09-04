/**
 * When the router seeds a new thread session with platform thread history.
 *
 * Exercised through the REAL routeInbound path with a registered adapter, so
 * the conditions asserted here are the live ones: the mention must have
 * CREATED the session, and the wiring must be on 'accumulate'. A 'drop'
 * wiring is the operator asking for no ambient context between mentions, and
 * reading the same messages off the platform would defeat that setting.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { inboundDbPath } from './mailbox/sqlite/paths.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { routeInbound } from './router.js';
import type { ChannelAdapter, ChannelDefaults, ThreadHistoryMessage } from './channels/adapter.js';
import type { MessagingGroupAgent } from './types.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-thread-history-seed' };
});

const TEST_DIR = '/tmp/nanoclaw-test-thread-history-seed';

const fetchCalls: Array<{ platformId: string; threadId: string; limit: number }> = [];
let historyToReturn: ThreadHistoryMessage[] = [];
let adapterCanFetch = true;

function now(): string {
  return new Date().toISOString();
}

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'public' },
  mentions: 'platform',
};

function makeAdapter(): ChannelAdapter {
  const adapter: ChannelAdapter = {
    name: 'testchat',
    channelType: 'testchat',
    supportsThreads: true,
    defaults: channelDefaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  };
  if (adapterCanFetch) {
    adapter.fetchThreadHistory = async (platformId: string, threadId: string, limit: number) => {
      fetchCalls.push({ platformId, threadId, limit });
      return historyToReturn;
    };
  }
  return adapter;
}

async function activate(): Promise<void> {
  registerChannelAdapter('testchat', { factory: () => makeAdapter(), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

async function seedWiring(options: {
  isGroup?: 0 | 1;
  engageMode?: MessagingGroupAgent['engage_mode'];
  ignoredMessagePolicy?: 'drop' | 'accumulate';
}): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Saber',
    folder: 'saber',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'ai-anya',
    is_group: options.isGroup ?? 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: options.engageMode ?? 'mention-sticky',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: options.ignoredMessagePolicy ?? 'accumulate',
    session_mode: 'per-thread',
    priority: 0,
    threads: 1,
    created_at: now(),
  });
}

async function inbound(id: string, threadId: string | null, text: string, isMention = true): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Kien', senderId: 'U079', text }),
      timestamp: now(),
      isMention,
      isGroup: true,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function history(id: string, text: string): ThreadHistoryMessage {
  return {
    id,
    timestamp: '2026-09-03T05:00:00.000Z',
    sender: 'Kien',
    senderId: 'U079',
    text,
    self: false,
  };
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  fetchCalls.length = 0;
  historyToReturn = [history('h1', 'which ticket?'), history('h2', 'PBC-13')];
  adapterCanFetch = true;
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('router — thread-history seeding', () => {
  it('reads the thread’s history once, when the mention creates the session', async () => {
    await activate();
    await seedWiring({});

    await inbound('m1', 'testchat:C1:100.0', '@saber PBC-13 blueprint');

    expect(fetchCalls).toEqual([{ platformId: 'testchat:C1', threadId: 'testchat:C1:100.0', limit: 12 }]);
  });

  it('lands every history row at a lower seq than the mention that fetched it', async () => {
    // The one invariant the whole feature produces: the prelude must sort
    // BEFORE the live turn, because the container reads ORDER BY seq. Asserted
    // against the stored rows, so reordering deliverToAgent breaks a test
    // rather than silently inverting the prompt.
    await activate();
    await seedWiring({});

    await inbound('m1', 'testchat:C1:100.0', '@saber PBC-13 blueprint');

    const [session] = await getSessionsByAgentGroup('ag-1');
    const db = new Database(inboundDbPath('ag-1', session.id), { readonly: true });
    const rows = db.prepare('SELECT seq, channel_type, "trigger" FROM messages_in ORDER BY seq').all() as Array<{
      seq: number;
      channel_type: string | null;
      trigger: number;
    }>;
    db.close();

    const seeded = rows.filter((r) => r.channel_type === 'session-echo');
    const trigger = rows.find((r) => r.trigger === 1);
    expect(seeded).toHaveLength(2);
    expect(trigger).toBeDefined();
    for (const row of seeded) expect(row.seq).toBeLessThan(trigger!.seq);
  });

  it('suppresses the sibling backfill when thread history seeded rows', async () => {
    // The container caps context rows per prompt and keeps the newest by seq,
    // so writing both preludes leaves one written and never read, with its
    // unread rows resurfacing as stale prelude in a later turn.
    await activate();
    await seedWiring({});

    await inbound('m1', 'testchat:C1:100.0', '@saber first thread');
    await inbound('m2', 'testchat:C1:200.0', '@saber second thread');

    const sessions = await getSessionsByAgentGroup('ag-1');
    const second = sessions.find((s) => s.thread_id === 'testchat:C1:200.0');
    expect(second).toBeDefined();

    const db = new Database(inboundDbPath('ag-1', second!.id), { readonly: true });
    const echoes = db
      .prepare("SELECT content FROM messages_in WHERE channel_type = 'session-echo' ORDER BY seq")
      .all() as Array<{ content: string }>;
    db.close();

    // Exactly the two thread-history rows. A sibling-backfill row would carry
    // no echo.sentAt, because only the platform read supplies one.
    expect(echoes).toHaveLength(2);
    for (const echo of echoes) {
      expect(JSON.parse(echo.content).echo.sentAt).toBe('2026-09-03T05:00:00.000Z');
    }
  });

  it('does not read again for a session that already exists', async () => {
    await activate();
    await seedWiring({});

    await inbound('m1', 'testchat:C1:100.0', '@saber first');
    await inbound('m2', 'testchat:C1:100.0', '@saber follow-up');

    expect(fetchCalls).toHaveLength(1);
  });

  it('reads per thread, because each thread is its own session', async () => {
    await activate();
    await seedWiring({});

    await inbound('m1', 'testchat:C1:100.0', '@saber one');
    await inbound('m2', 'testchat:C1:200.0', '@saber two');

    expect(fetchCalls.map((c) => c.threadId)).toEqual(['testchat:C1:100.0', 'testchat:C1:200.0']);
  });

  it('reads on a drop wiring, which is the case with no local fallback', async () => {
    // A drop wiring discards non-engaging messages, so its threads never
    // create a session until the mention lands — making it the case most in
    // need of a platform read, not the case to exclude. 'drop' is also the
    // schema default, so gating it out left a fresh install with nothing.
    await activate();
    await seedWiring({ ignoredMessagePolicy: 'drop' });

    await inbound('m1', 'testchat:C1:100.0', '@saber PBC-13 blueprint');

    expect(fetchCalls).toEqual([{ platformId: 'testchat:C1', threadId: 'testchat:C1:100.0', limit: 12 }]);
  });

  it('never reads for an accumulated message, which does not wake the agent', async () => {
    await activate();
    await seedWiring({ engageMode: 'mention' });

    await inbound('m1', 'testchat:C1:100.0', 'humans talking', false);

    expect(fetchCalls).toEqual([]);
  });

  it('delivers the mention when the adapter cannot read history', async () => {
    adapterCanFetch = false;
    await activate();
    await seedWiring({});

    await expect(inbound('m1', 'testchat:C1:100.0', '@saber PBC-13')).resolves.toBeUndefined();

    expect(fetchCalls).toEqual([]);
  });

  it('delivers the mention when the platform read rejects', async () => {
    await activate();
    await seedWiring({});
    const adapter = makeAdapter();
    adapter.fetchThreadHistory = async () => {
      throw new Error('slack 429');
    };
    registerChannelAdapter('testchat', { factory: () => adapter, defaults: channelDefaults });

    await expect(inbound('m1', 'testchat:C1:100.0', '@saber PBC-13')).resolves.toBeUndefined();
  });
});
