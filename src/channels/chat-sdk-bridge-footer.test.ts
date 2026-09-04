/**
 * The telemetry footer's outbound rendering.
 *
 * The footer arrives as its OWN content field, so a channel that can style it
 * does. Slack renders a small grey `context` block, and everything else
 * appends. The failure guarded against is a silent drop when the card path
 * stops matching.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, CardElement, RawMessage } from 'chat';

import { createChatSdkBridge } from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

const FOOTER = 'Wego #1 · opus-5 · ctx: 54% · 5h: 31% · 7d: 12%';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface PostCall {
  threadId: string;
  message: AdapterPostableMessage;
}

function makePostCapture() {
  const calls: PostCall[] = [];
  const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, message });
    return { id: 'msg-stub', threadId, raw: {} };
  };
  return { calls, postMessage };
}

/** The card's children, as the Block Kit converter will walk them. */
function cardChildren(calls: PostCall[]): Array<Record<string, unknown>> {
  const message = calls[0]?.message as { card?: CardElement } | undefined;
  const card = message?.card as unknown as { children?: Array<Record<string, unknown>> } | undefined;
  return card?.children ?? [];
}

function markdownOf(calls: PostCall[]): string | undefined {
  return (calls[0]?.message as { markdown?: string } | undefined)?.markdown;
}

function bridgeWith(postMessage: Adapter['postMessage'], maxTextLength?: number) {
  return createChatSdkBridge({
    adapter: stubAdapter({ postMessage }),
    supportsThreads: false,
    ...(maxTextLength ? { maxTextLength } : {}),
  });
}

describe('telemetry footer rendering', () => {
  it('renders the footer as a muted element, which Slack turns into a context block', async () => {
    const { calls, postMessage } = makePostCapture();
    await bridgeWith(postMessage).deliver('slack:C1', null, {
      kind: 'chat',
      content: { text: 'pong — here. What is up?', footer: FOOTER },
    });

    const children = cardChildren(calls);
    expect(children).toHaveLength(2);
    // The body carries no style: styling it would make the reply itself grey.
    expect(children[0]?.style).toBeUndefined();
    // `muted` is the whole feature. Any other style renders as a normal
    // section — same size, same colour as the reply.
    expect(children[1]?.style).toBe('muted');
  });

  it('carries a fallback that still contains the footer', async () => {
    // The fallback is what a notification and an unfurl-less client show. A
    // footer missing there is the same silent drop, one layer down.
    const { calls, postMessage } = makePostCapture();
    await bridgeWith(postMessage).deliver('slack:C1', null, {
      kind: 'chat',
      content: { text: 'body', footer: FOOTER },
    });

    expect((calls[0]?.message as { fallbackText?: string }).fallbackText).toContain(FOOTER);
  });

  it('posts plain markdown when there is no footer', async () => {
    // The common path must not become a card just because the feature exists.
    const { calls, postMessage } = makePostCapture();
    await bridgeWith(postMessage).deliver('slack:C1', null, {
      kind: 'chat',
      content: { text: 'body' },
    });

    expect(markdownOf(calls)).toBe('body');
    expect((calls[0]?.message as { card?: unknown }).card).toBeUndefined();
  });

  it('appends rather than drops the footer when the body is too long for one section', async () => {
    // Slack caps a section block at 3000 characters, so an oversized body
    // takes the markdown path. The footer must survive that detour.
    const { calls, postMessage } = makePostCapture();
    const body = 'x'.repeat(5_000);
    await bridgeWith(postMessage).deliver('slack:C1', null, {
      kind: 'chat',
      content: { text: body, footer: FOOTER },
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((c) => (c.message as { markdown?: string }).markdown ?? '').join('')).toContain(FOOTER);
  });

  it('takes the markdown path when the body is too long for THIS adapter', async () => {
    // The card path posts one message and cannot split. Gating it on the
    // Slack section cap alone sent a 2,500-character reply through it unsplit
    // on an adapter capped at 2,000 — over that adapter's limit, where before
    // the footer existed the body was chunked.
    const { calls, postMessage } = makePostCapture();
    const body = 'x'.repeat(2_500);
    await bridgeWith(postMessage, 2_000).deliver('slack:C1', null, {
      kind: 'chat',
      content: { text: body, footer: FOOTER },
    });

    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(((call.message as { markdown?: string }).markdown ?? '').length).toBeLessThanOrEqual(2_000);
      expect((call.message as { card?: unknown }).card).toBeUndefined();
    }
    expect(calls.map((c) => (c.message as { markdown?: string }).markdown ?? '').join('')).toContain(FOOTER);
  });

  it('still styles the footer when the body fits the adapter limit', async () => {
    const { calls, postMessage } = makePostCapture();
    await bridgeWith(postMessage, 2_000).deliver('slack:C1', null, {
      kind: 'chat',
      content: { text: 'body', footer: FOOTER },
    });

    expect(cardChildren(calls).length).toBe(2);
  });

  it('ignores a blank footer instead of posting an empty muted block', async () => {
    const { calls, postMessage } = makePostCapture();
    await bridgeWith(postMessage).deliver('slack:C1', null, {
      kind: 'chat',
      content: { text: 'body', footer: '   ' },
    });

    expect(markdownOf(calls)).toBe('body');
    expect((calls[0]?.message as { card?: unknown }).card).toBeUndefined();
  });
});
