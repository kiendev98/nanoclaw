/**
 * Thread-history seeding: when a mention creates a brand-new thread session,
 * the adapter is asked for the thread's OWN earlier messages and they are
 * written as trigger=0 echo rows before the triggering message. Live-hit this
 * guards against: 12 messages settling a Jira ticket, the agent tagged at
 * reply #12, and the fresh session holding only those four tagging words.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ThreadHistoryMessage } from '../../channels/adapter.js';

const written: Array<Record<string, unknown>> = [];
let storedIds = new Set<string>();
let sessionExists = true;

vi.mock('../../session-manager.js', () => ({
  withExistingMailboxSession: (_g: string, _s: string, fn: (mailbox: unknown) => unknown) =>
    sessionExists ? fn({ hasMessage: (id: string) => storedIds.has(id) }) : undefined,
  writeSessionMessage: async (agentGroupId: string, sessionId: string, msg: Record<string, unknown>) => {
    written.push({ agentGroupId, sessionId, ...msg });
  },
}));
vi.mock('../../db/sessions.js', () => ({
  isTaskThread: (t: string) => t.startsWith('system:tasks'),
}));

const { seedThreadHistory, threadHistoryRowId, THREAD_HISTORY_LIMIT, THREAD_HISTORY_FETCH_TIMEOUT_MS } =
  await import('./thread-history.js');

const AG = { id: 'ag-1', name: 'Saber', folder: 'saber' } as never;
const ROOM_MG = { id: 'mg-room', channel_type: 'slack', platform_id: 'slack:C1', is_group: 1 } as never;
const DM_MG = { id: 'mg-dm', channel_type: 'slack', platform_id: 'slack:D1', is_group: 0 } as never;
const SESSION = {
  id: 'sess-new',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-room',
  thread_id: 'slack:C1:100.0',
} as never;

function history(id: string, text: string, over: Partial<ThreadHistoryMessage> = {}): ThreadHistoryMessage {
  return {
    id,
    timestamp: '2026-09-03T05:00:00.000Z',
    sender: 'Kien',
    senderId: 'U079',
    text,
    self: false,
    ...over,
  };
}

interface SeedOverrides {
  messages?: ThreadHistoryMessage[];
  readThreadHistory?: ((platformId: string, threadId: string, limit: number) => Promise<ThreadHistoryMessage[]>) | null;
  mg?: never;
  threadId?: string | null;
  ignoredMessagePolicy?: 'drop' | 'accumulate';
  triggerMessageId?: string;
}

const calls: Array<{ platformId: string; threadId: string; limit: number }> = [];

async function seed(over: SeedOverrides = {}): Promise<void> {
  const recording = async (platformId: string, threadId: string, limit: number) => {
    calls.push({ platformId, threadId, limit });
    return over.messages ?? [];
  };
  const readThreadHistory = over.readThreadHistory === undefined ? recording : (over.readThreadHistory ?? undefined);
  await seedThreadHistory({
    agentGroup: AG,
    session: SESSION,
    mg: over.mg ?? ROOM_MG,
    readThreadHistory,
    platformId: 'slack:C1',
    threadId: over.threadId === undefined ? 'slack:C1:100.0' : over.threadId,
    ignoredMessagePolicy: over.ignoredMessagePolicy ?? 'accumulate',
    triggerMessageId: over.triggerMessageId ?? 'trigger-1',
    toLocalMessageId: (platformMessageId: string) => `${platformMessageId}:ag-1`,
  });
}

function textOf(row: Record<string, unknown>): string {
  return (JSON.parse(row.content as string) as { text: string }).text;
}

beforeEach(() => {
  written.length = 0;
  calls.length = 0;
  storedIds = new Set<string>();
  sessionExists = true;
});

describe('seedThreadHistory', () => {
  it('writes the thread’s earlier messages as trigger=0 echo rows', async () => {
    await seed({ messages: [history('m1', 'which ticket?'), history('m2', 'PBC-13')] });

    expect(written).toHaveLength(2);
    expect(written.map((r) => r.trigger)).toEqual([false, false]);
    expect(written.map(textOf)).toEqual(['which ticket?', 'PBC-13']);
    expect(written[0].channelType).toBe('session-echo');
    expect(written[0].id).toBe(threadHistoryRowId('m1', 'sess-new'));
  });

  it('asks the adapter for at most THREAD_HISTORY_LIMIT messages', async () => {
    await seed({ messages: [history('m1', 'hi')] });

    expect(calls).toEqual([{ platformId: 'slack:C1', threadId: 'slack:C1:100.0', limit: THREAD_HISTORY_LIMIT }]);
    expect(THREAD_HISTORY_LIMIT).toBe(12);
  });

  it('never re-seeds the mention that created the session', async () => {
    await seed({
      messages: [history('m1', 'earlier'), history('trigger-1', '@saber PBC-13')],
      triggerMessageId: 'trigger-1',
    });

    expect(written.map(textOf)).toEqual(['earlier']);
  });

  it('skips a message the accumulate path already stored', async () => {
    storedIds.add('m1:ag-1');

    await seed({ messages: [history('m1', 'already here'), history('m2', 'new')] });

    expect(written.map(textOf)).toEqual(['new']);
  });

  it('skips a message a previous seeding run already wrote', async () => {
    storedIds.add(threadHistoryRowId('m1', 'sess-new'));

    await seed({ messages: [history('m1', 'seeded before'), history('m2', 'new')] });

    expect(written.map(textOf)).toEqual(['new']);
  });

  it('writes nothing when every message is already present', async () => {
    storedIds.add('m1:ag-1');

    await seed({ messages: [history('m1', 'already here')] });

    expect(written).toEqual([]);
  });

  it('truncates earlier entries and delivers the last one whole', async () => {
    const long = 'x'.repeat(5000);

    await seed({ messages: [history('m1', long), history('m2', long)] });

    expect(textOf(written[0])).toBe(`${'x'.repeat(500)}…`);
    expect(textOf(written[1])).toBe('x'.repeat(4000));
  });

  it('marks the agent’s own posts self so the container renders them as "you"', async () => {
    await seed({ messages: [history('m1', 'mine', { self: true }), history('m2', 'theirs')] });

    expect(JSON.parse(written[0].content as string).self).toBe(true);
    expect(JSON.parse(written[1].content as string).self).toBeUndefined();
  });

  it('seeds a group thread under channel-timeline and a DM under dm-timeline', async () => {
    await seed({ messages: [history('m1', 'group')] });
    const groupSurface = JSON.parse(written[0].content as string).echo.surface;

    written.length = 0;
    await seed({ messages: [history('m1', 'dm')], mg: DM_MG });
    const dmSurface = JSON.parse(written[0].content as string).echo.surface;

    expect(groupSurface).toBe('channel-timeline');
    expect(dmSurface).toBe('dm-timeline');
  });

  it('no-ops when the channel cannot read thread history', async () => {
    await seed({ readThreadHistory: null, messages: [history('m1', 'hi')] });

    expect(written).toEqual([]);
  });

  it('no-ops on a drop wiring, which asks for no ambient context', async () => {
    await seed({ messages: [history('m1', 'hi')], ignoredMessagePolicy: 'drop' });

    expect(calls).toEqual([]);
    expect(written).toEqual([]);
  });

  it('no-ops for a session with no thread', async () => {
    await seed({ messages: [history('m1', 'hi')], threadId: null });

    expect(calls).toEqual([]);
    expect(written).toEqual([]);
  });

  it('no-ops for a task thread', async () => {
    await seed({ messages: [history('m1', 'hi')], threadId: 'system:tasks:daily' });

    expect(calls).toEqual([]);
    expect(written).toEqual([]);
  });

  it('delivers the message without a prelude when the fetch rejects', async () => {
    await expect(
      seed({
        readThreadHistory: async () => {
          throw new Error('slack 429');
        },
      }),
    ).resolves.toBeUndefined();

    expect(written).toEqual([]);
  });

  it('gives up on a slow platform instead of holding up delivery', async () => {
    vi.useFakeTimers();
    try {
      const pending = seed({ readThreadHistory: () => new Promise<ThreadHistoryMessage[]>(() => {}) });
      await vi.advanceTimersByTimeAsync(THREAD_HISTORY_FETCH_TIMEOUT_MS + 1);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    expect(written).toEqual([]);
  });

  it('seeds every fetched message when the session mailbox cannot be read', async () => {
    sessionExists = false;

    await seed({ messages: [history('m1', 'a'), history('m2', 'b')] });

    expect(written.map(textOf)).toEqual(['a', 'b']);
  });
});
