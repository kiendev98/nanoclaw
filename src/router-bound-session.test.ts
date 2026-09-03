/**
 * The router's second fan-out pass: a reply reaches the session that OPENED
 * the thread, even when that session's agent group is not wired to the chat.
 *
 * The case is a repo worker granted one channel for one job. It posts, a
 * thread forms around its post, and a human replies in that thread. The wired
 * fan-out cannot find it — `getMessagingGroupAgents` answers "who is wired
 * here", and the whole point of this agent is that it is not. Without the
 * second pass the reply is recorded as `no_agent_engaged` and the person is
 * answering something that never hears them.
 *
 * Two properties matter more than the delivery itself, and both fail quietly:
 * the pass is ADDITIVE, so no wired agent behaves differently than it did
 * before it existed; and it is THREAD-SCOPED, so the grant is one thread
 * rather than the channel.
 *
 * Exercised through the REAL routeInbound path (adapter registry + seeded
 * wiring), not by calling the dispatch directly.
 */
import fs from 'fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock container runner to prevent actual Docker spawning
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Override DATA_DIR for tests
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-router-bound-session' };
});

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  getAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  createSession,
  bindSessionToThread,
} from './db/index.js';
import { setMessagingGroupDeniedAt } from './db/messaging-groups.js';
import { getUnregisteredSenders } from './db/dropped-messages.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { inboundDbPath } from './mailbox/sqlite/paths.js';
import { routeInbound } from './router.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';
import type { MessagingGroupAgent } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-router-bound-session';

/** The thread the worker opened: root message id `171` in this channel. */
const BOUND_ROOT = '171';
const BOUND_THREAD = `testchat:C1:${BOUND_ROOT}`;
/** Another thread in the SAME channel, which the worker never opened. */
const OTHER_THREAD = 'testchat:C1:942';

const WORKER_SESSION = 'sess-worker';

function now(): string {
  return new Date().toISOString();
}

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

function makeAdapter(): ChannelAdapter {
  return {
    name: 'testchat',
    channelType: 'testchat',
    supportsThreads: true,
    defaults: channelDefaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  };
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

/** The chat, plus one wired agent that only engages when mentioned. */
async function seedChat(engageMode: MessagingGroupAgent['engage_mode'] = 'mention'): Promise<void> {
  await createAgentGroup({
    id: 'ag-wired',
    name: 'Orchestrator',
    folder: 'orchestrator',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'ai-anya',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-wired',
    engage_mode: engageMode,
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    threads: 1,
    created_at: now(),
  });
}

/**
 * The same chat with NOTHING wired to it, and optionally refused by the owner.
 *
 * This is the shape that used to lose the reply: `agentCount` counts
 * `messaging_group_agents` rows and a binding writes none, so the router
 * short-circuited ~160 lines before the pass that would have delivered.
 */
async function seedUnwiredChat(deniedAt: string | null = null): Promise<void> {
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'ai-anya',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  // Stamped separately because the insert above does not carry the column —
  // a refusal is an admin action on an existing row, never part of creating one.
  if (deniedAt) await setMessagingGroupDeniedAt('mg-1', deniedAt);
}

/**
 * A worker with a session of its own and a binding on the thread it opened.
 *
 * `messaging_group_id` is null on purpose: a worker's session belongs to the
 * lane back to its orchestrator, not to this chat. That is exactly why the
 * wired fan-out cannot reach it, and why the binding has to.
 */
async function seedBoundWorker(agentGroupId = 'ag-worker'): Promise<void> {
  // One test binds a session to the WIRED group, to prove the pass stands
  // down for a group the loop already served. That group already exists.
  if (!(await getAgentGroup(agentGroupId))) {
    await createAgentGroup({
      id: agentGroupId,
      name: 'Scout',
      folder: agentGroupId,
      agent_provider: null,
      created_at: now(),
    });
  }
  await createSession({
    id: WORKER_SESSION,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  await bindSessionToThread(WORKER_SESSION, 'mg-1', BOUND_ROOT);
}

async function inbound(id: string, threadId: string | null, text: string, isMention = false): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Anya', senderId: 'U1', text }),
      timestamp: now(),
      isMention,
      isGroup: true,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Rows in one session's inbound.db, or [] when it has no database yet. */
function inboundRows(agentGroupId: string, sessionId: string): Array<{ id: string; content: string; trigger: number }> {
  const path = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare('SELECT id, content, trigger FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      content: string;
      trigger: number;
    }>;
  } finally {
    db.close();
  }
}

/** Whether any session of this agent group received anything at all. */
function sessionDirsFor(agentGroupId: string): string[] {
  const dir = `${TEST_DIR}/v2-sessions/${agentGroupId}`;
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  vi.clearAllMocks();
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('a reply in a bound thread reaches the session that opened it', () => {
  it('delivers to the bound session even though its agent group is not wired here', async () => {
    await activate();
    await seedChat();
    await seedBoundWorker();

    await inbound('m1', BOUND_THREAD, 'rework the migration');

    const rows = inboundRows('ag-worker', WORKER_SESSION);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('rework the migration');
  });

  it('wakes it, rather than leaving the message as silent context', async () => {
    // The binding IS the engagement signal — the session opened that thread on
    // purpose, so a reply in it is addressed to it by construction.
    await activate();
    await seedChat();
    await seedBoundWorker();

    await inbound('m1', BOUND_THREAD, 'rework the migration');

    expect(inboundRows('ag-worker', WORKER_SESSION)[0].trigger).toBe(1);
  });

  it('does not record the message as dropped', async () => {
    // Without counting the bound delivery, a message that WAS delivered would
    // be audited as `no_agent_engaged` — a dropped-message row for a
    // conversation that is working.
    await activate();
    await seedChat();
    await seedBoundWorker();

    await inbound('m1', BOUND_THREAD, 'rework the migration');

    expect(await getUnregisteredSenders()).toHaveLength(0);
  });
});

describe('a channel with nothing else wired to it', () => {
  it('still delivers to the bound session', async () => {
    // The motivating regression. `agentCount === 0` returns before the fan-out,
    // and a binding writes no wiring row for that count to see — so lending a
    // worker a channel no other agent uses lost every reply, while the post it
    // was replying to had gone out perfectly well.
    await seedUnwiredChat();
    await seedBoundWorker();
    await activate();

    await inbound('m-unwired', BOUND_THREAD, 'rework the migration');

    const rows = inboundRows('ag-worker', WORKER_SESSION);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('rework the migration');
  });

  it('does not record that reply as an unwired-channel drop', async () => {
    // A delivered message must not also be audited as lost, or the operator
    // is told the channel needs wiring it does not need.
    await seedUnwiredChat();
    await seedBoundWorker();
    await activate();

    await inbound('m-unwired-2', BOUND_THREAD, 'rework the migration', true);

    expect(await getUnregisteredSenders()).toHaveLength(0);
  });

  it('refuses when the owner denied the channel', async () => {
    // `denied_at` is a person saying this channel may not be used. A session
    // that opened a thread there before the refusal must not be the way back
    // in — the binding does not outrank the human.
    await seedUnwiredChat(now());
    await seedBoundWorker();
    await activate();

    await inbound('m-denied', BOUND_THREAD, 'rework the migration', true);

    expect(inboundRows('ag-worker', WORKER_SESSION)).toHaveLength(0);
  });

  it('still drops an ordinary message when nothing is bound', async () => {
    // The short-circuit this branch exists for is unchanged: an unwired
    // channel with no binding behaves exactly as it did before.
    await seedUnwiredChat();
    await activate();

    await inbound('m-plain', OTHER_THREAD, 'hello?', true);

    expect(sessionDirsFor('ag-worker')).toHaveLength(0);
    expect(await getUnregisteredSenders()).toHaveLength(1);
  });

  it('ignores a reply in another thread of that same unwired channel', async () => {
    // Thread-scoped, on this path too: the grant is one thread, not the chat.
    await seedUnwiredChat();
    await seedBoundWorker();
    await activate();

    await inbound('m-other', OTHER_THREAD, 'unrelated', true);

    expect(inboundRows('ag-worker', WORKER_SESSION)).toHaveLength(0);
  });
});

describe('the grant is one thread, not the channel', () => {
  it('ignores a reply in a different thread of the same channel', async () => {
    await activate();
    await seedChat();
    await seedBoundWorker();

    await inbound('m1', OTHER_THREAD, 'unrelated conversation');

    expect(inboundRows('ag-worker', WORKER_SESSION)).toHaveLength(0);
  });

  it('ignores a top-level post, which is nobody thread reply', async () => {
    await activate();
    await seedChat();
    await seedBoundWorker();

    await inbound('m1', null, 'channel chatter');

    expect(inboundRows('ag-worker', WORKER_SESSION)).toHaveLength(0);
  });

  it('still records an unengaged message elsewhere as dropped', async () => {
    // The pass adds a delivery; it must not suppress the audit trail for
    // messages it did not take.
    await activate();
    await seedChat();
    await seedBoundWorker();

    await inbound('m1', OTHER_THREAD, 'unrelated conversation');

    const dropped = await getUnregisteredSenders();
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toBe('no_agent_engaged');
  });
});

describe('wired agents are unaffected', () => {
  it('does not make a non-engaging wired agent engage', async () => {
    // `mention` wiring, unmentioned message: the wired agent must stay out of
    // it exactly as before, even though the same message is delivered to the
    // bound session beside it.
    await activate();
    await seedChat('mention');
    await seedBoundWorker();

    await inbound('m1', BOUND_THREAD, 'rework the migration');

    expect(sessionDirsFor('ag-wired')).toHaveLength(0);
    expect(inboundRows('ag-worker', WORKER_SESSION)).toHaveLength(1);
  });

  it('delivers to a wired agent that does engage, with no bound session present', async () => {
    await activate();
    await seedChat('pattern');

    await inbound('m1', BOUND_THREAD, 'hello there');

    const [session] = sessionDirsFor('ag-wired');
    expect(session).toBeDefined();
    expect(inboundRows('ag-wired', session)).toHaveLength(1);
  });
});

describe('a group the wired pass already served is skipped', () => {
  it('delivers exactly once when the bound session belongs to a wired agent', async () => {
    // `resolveSession`'s own binding hook already routes the wired delivery
    // into this session. A second write would carry the same namespaced
    // `messages_in.id` and collide, so the pass has to stand down.
    await activate();
    await seedChat('pattern');
    await seedBoundWorker('ag-wired');

    await inbound('m1', BOUND_THREAD, 'hello there');

    expect(inboundRows('ag-wired', WORKER_SESSION)).toHaveLength(1);
  });
});
