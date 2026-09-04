/**
 * The bridge's thread-history read. fetchMessages is required on the Chat SDK
 * Adapter contract, so this one generic implementation gives every Chat SDK
 * channel thread history — no per-channel Slack code. The bridge only maps and
 * filters; the caller owns the failure policy, exactly as with subscribe.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Adapter, FetchOptions, Message } from 'chat';

import { createChatSdkBridge } from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface AuthorOverrides {
  userId?: string;
  fullName?: string;
  userName?: string;
  isMe?: boolean;
  isSystem?: boolean;
}

function message(id: string, text: string, author: AuthorOverrides = {}): Message {
  return {
    id,
    text,
    metadata: { dateSent: new Date('2026-09-03T05:00:00.000Z') },
    author: {
      userId: 'U079',
      fullName: 'Kien',
      userName: 'kien',
      isBot: false,
      isMe: false,
      ...author,
    },
  } as unknown as Message;
}

function bridgeReturning(messages: Message[], capture?: Array<{ threadId: string; options?: FetchOptions }>) {
  return createChatSdkBridge({
    adapter: stubAdapter({
      fetchMessages: async (threadId: string, options?: FetchOptions) => {
        capture?.push({ threadId, options });
        return { messages, nextCursor: undefined } as never;
      },
    }),
    supportsThreads: true,
  });
}

describe('createChatSdkBridge — fetchThreadHistory', () => {
  it('omits fetchThreadHistory when the adapter copy predates fetchMessages', () => {
    const bridge = createChatSdkBridge({ adapter: stubAdapter({}), supportsThreads: true });

    expect(bridge.fetchThreadHistory).toBeUndefined();
  });

  it('reads the most recent messages, oldest first within the page', async () => {
    const calls: Array<{ threadId: string; options?: FetchOptions }> = [];
    const bridge = bridgeReturning([message('m1', 'first'), message('m2', 'second')], calls);

    const history = await bridge.fetchThreadHistory!('slack:C1', 'slack:C1:100.0', 12);

    expect(calls).toEqual([{ threadId: 'slack:C1:100.0', options: { direction: 'backward', limit: 12 } }]);
    expect(history.map((h) => h.text)).toEqual(['first', 'second']);
  });

  it('projects the nested author onto the flat sender fields', async () => {
    const bridge = bridgeReturning([message('m1', 'which ticket?')]);

    const [entry] = await bridge.fetchThreadHistory!('slack:C1', 'slack:C1:100.0', 12);

    expect(entry).toEqual({
      id: 'm1',
      timestamp: '2026-09-03T05:00:00.000Z',
      sender: 'Kien',
      senderId: 'U079',
      text: 'which ticket?',
      self: false,
    });
  });

  it('falls back to the handle when the platform reports no full name', async () => {
    const bridge = bridgeReturning([message('m1', 'hi', { fullName: undefined })]);

    const [entry] = await bridge.fetchThreadHistory!('slack:C1', 'slack:C1:100.0', 12);

    expect(entry.sender).toBe('kien');
  });

  it('marks this bot’s own posts self', async () => {
    const bridge = bridgeReturning([message('m1', 'mine', { isMe: true }), message('m2', 'theirs')]);

    const history = await bridge.fetchThreadHistory!('slack:C1', 'slack:C1:100.0', 12);

    expect(history.map((h) => h.self)).toEqual([true, false]);
  });

  it('drops platform-generated and empty messages', async () => {
    const bridge = bridgeReturning([
      message('m1', 'a joined the channel', { isSystem: true }),
      message('m2', '   '),
      message('m3', 'real'),
    ]);

    const history = await bridge.fetchThreadHistory!('slack:C1', 'slack:C1:100.0', 12);

    expect(history.map((h) => h.id)).toEqual(['m3']);
  });

  it('propagates a platform failure rather than swallowing it', async () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        fetchMessages: async () => {
          throw new Error('slack 429');
        },
      }),
      supportsThreads: true,
    });

    await expect(bridge.fetchThreadHistory!('slack:C1', 'slack:C1:100.0', 12)).rejects.toThrow('slack 429');
  });
});
