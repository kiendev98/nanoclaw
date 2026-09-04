/**
 * Where the lent-thread hook sits in `routeInbound`, and what it still obeys.
 *
 * The hook runs ahead of the no-wiring drop on purpose: a lent channel usually
 * carries no wiring of its own, so behind that drop every reply in a lent
 * thread was lost (D5). Running early means it also runs ahead of the
 * `denied_at` check that lived inside the drop — so it has to make that check
 * itself, or an operator's denial stops applying to a thread lent before it
 * (D11).
 *
 * Exercised through the REAL routeInbound path, not by calling the hook.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from './db/index.js';
import { setMessagingGroupDeniedAt } from './db/messaging-groups.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { registerWorkerMigration } from './modules/worker-delegation/db/migrate.js';
import { routeInbound } from './router.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  restartContainer: vi.fn(),
}));

const { deliverToLentConversation } = vi.hoisted(() => ({
  deliverToLentConversation: vi.fn().mockResolvedValue(true),
}));

vi.mock('./modules/worker-delegation/lend/inbound-route.js', () => ({ deliverToLentConversation }));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-worker-lent-thread' };
});

const TEST_DIR = '/tmp/nanoclaw-test-worker-lent-thread';

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

/** A channel with no agent wired to it — exactly what a lent channel looks like. */
async function seedLentChannel(): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-lent',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'Lent Chat',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

async function inbound(threadId: string | null): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId,
    message: {
      id: `m-${Math.random().toString(36).slice(2)}`,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Reviewer', senderId: 'U9', text: 'rework this' }),
      timestamp: now(),
      isMention: false,
      isGroup: true,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  deliverToLentConversation.mockClear();
  registerWorkerMigration();
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('the worker lent-thread hook in routeInbound', () => {
  // The reply carries no mention, and no agent is wired to the channel. Both
  // of those drop a message on the ordinary path, which is the whole reason
  // the hook runs first.
  it('consults the hook for an unmentioned reply on an unwired channel (D5)', async () => {
    await seedLentChannel();
    await activate();

    await inbound('thread-1');

    expect(deliverToLentConversation).toHaveBeenCalledTimes(1);
    expect(deliverToLentConversation.mock.calls[0]![0]).toMatchObject({
      messagingGroupId: 'mg-lent',
      threadId: 'thread-1',
      channelType: 'testchat',
    });
  });

  // D11. The operator denied this channel AFTER the thread was lent, so the
  // grant still exists and the hook would otherwise take the message.
  it('does not consult the hook on a channel the operator denied (D11)', async () => {
    await seedLentChannel();
    await setMessagingGroupDeniedAt('mg-lent', now());
    await activate();

    await inbound('thread-1');

    expect(deliverToLentConversation).not.toHaveBeenCalled();
  });
});
