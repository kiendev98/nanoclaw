/**
 * mention-sticky at RUNTIME, through the real routeInbound path.
 *
 * Every existing mention-sticky test covers wiring-CREATION coercion. The
 * live per-message decision — evaluateEngage's `findSessionForAgent` branch,
 * which lets an unmentioned follow-up engage because the thread was engaged
 * before — had no coverage at all. That branch is what makes a thread
 * conversational after one mention, and what makes the is_group=0
 * short-circuit matter, so it is asserted here directly.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { getUnregisteredSenders } from './db/dropped-messages.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { routeInbound } from './router.js';
import { wakeContainer } from './container-runner.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-mention-sticky' };
});

const TEST_DIR = '/tmp/nanoclaw-test-mention-sticky';

function now(): string {
  return new Date().toISOString();
}

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'public' },
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

async function seedWiring(isGroup: 0 | 1): Promise<void> {
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
    is_group: isGroup,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention-sticky',
    engage_pattern: null,
    sender_scope: 'all',
    // 'drop' on purpose: a non-engaging message then leaves a
    // no_agent_engaged record, which is the observable for "did not engage".
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    threads: 1,
    created_at: now(),
  });
}

async function inbound(id: string, threadId: string | null, text: string, isMention: boolean): Promise<void> {
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

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  vi.mocked(wakeContainer).mockClear();
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('evaluateEngage — mention-sticky at runtime', () => {
  it('engages on the mention that opens a thread', async () => {
    await activate();
    await seedWiring(1);

    await inbound('m1', 'testchat:C1:100.0', '@saber PBC-13 blueprint', true);

    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
    expect(await getUnregisteredSenders()).toEqual([]);
  });

  it('keeps engaging an unmentioned follow-up in a thread it already joined', async () => {
    await activate();
    await seedWiring(1);

    await inbound('m1', 'testchat:C1:100.0', '@saber PBC-13 blueprint', true);
    await inbound('m2', 'testchat:C1:100.0', 'also check the model set', false);

    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(2);
    expect(await getUnregisteredSenders()).toEqual([]);
  });

  it('does not engage an unmentioned message in a thread it never joined', async () => {
    await activate();
    await seedWiring(1);

    await inbound('m1', 'testchat:C1:100.0', '@saber over here', true);
    await inbound('m2', 'testchat:C1:999.0', 'humans talking elsewhere', false);

    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
    const dropped = await getUnregisteredSenders();
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toBe('no_agent_engaged');
  });

  it('never engages an unmentioned first message in a DM, per the is_group short-circuit', async () => {
    await activate();
    await seedWiring(0);

    await inbound('m1', 'testchat:C1:100.0', 'no mention here', false);

    expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
    const dropped = await getUnregisteredSenders();
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toBe('no_agent_engaged');
  });
});
