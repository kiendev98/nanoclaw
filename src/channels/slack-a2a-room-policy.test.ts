/**
 * The A2A room policy's hop budget.
 *
 * `slack-a2a.test.ts` covers the GUARD — who is allowed to speak at all. This
 * covers the POLICY the guard consults: how much bot-to-bot chatter one
 * conversation may carry before it is cut off, and what counts as "one
 * conversation".
 *
 * The budget is per thread, because `#ai-anya` carries a live thread per pull
 * request and a room-wide budget let one review starve every other. The trap
 * that costs is the opposite one: Slack reports a TOP-LEVEL message's thread
 * id as its own timestamp, so a purely thread-keyed budget is unbounded — see
 * the root-bucket test.
 */
import { describe, expect, it } from 'vitest';

import { createA2aRoomPolicy } from './slack-a2a.js';
import type { InboundMessage } from './adapter.js';

const ROOM = 'C0ANYA';
const PLATFORM = `slack:${ROOM}`;

function config(maxHops: number) {
  return () => ({ rooms: new Set([ROOM]), maxHops });
}

function message(id: string): InboundMessage {
  return { id, kind: 'chat', content: { text: 'hi' }, timestamp: new Date().toISOString() };
}

/** One bot-authored inbound. Returns the decision, consuming budget on admit. */
function speak(policy: ReturnType<typeof createA2aRoomPolicy>, msgId: string, threadId: string | null) {
  const decision = policy.decideBotInbound({
    instanceKey: 'slack',
    platformId: PLATFORM,
    threadId,
    message: message(msgId),
    botId: 'B123',
  });
  if (decision.action === 'admit') decision.onAccepted?.();
  return decision;
}

/** A reply inside a thread: its own id differs from the thread's root. */
function reply(policy: ReturnType<typeof createA2aRoomPolicy>, msgId: string, root: string) {
  return speak(policy, msgId, `${PLATFORM}:${root}`);
}

/** A top-level post: Slack names its thread after the message itself. */
function topLevel(policy: ReturnType<typeof createA2aRoomPolicy>, msgId: string) {
  return speak(policy, msgId, `${PLATFORM}:${msgId}`);
}

describe('a2a hop budget', () => {
  it('drops a room that is not allowlisted', () => {
    const policy = createA2aRoomPolicy(() => ({ rooms: new Set(['C0OTHER']), maxHops: 5 }));
    expect(speak(policy, '1.1', null).action).toBe('drop');
  });

  it('spends the budget within one thread and then drops', () => {
    const policy = createA2aRoomPolicy(config(2));
    expect(reply(policy, '2.1', '1.1').action).toBe('admit');
    expect(reply(policy, '2.2', '1.1').action).toBe('admit');
    expect(reply(policy, '2.3', '1.1').action).toBe('drop');
  });

  it('keeps each thread on its own budget', () => {
    // The reason the key is per thread at all: one PR's review must not
    // spend the allowance of every other PR in the room.
    const policy = createA2aRoomPolicy(config(1));
    expect(reply(policy, '2.1', '1.1').action).toBe('admit');
    expect(reply(policy, '2.2', '1.1').action).toBe('drop');
    expect(reply(policy, '3.1', '9.9').action).toBe('admit');
  });

  it('bounds top-level posts, which name a thread after themselves', () => {
    // THE ESCAPE. Slack sets a root message's thread id to its own ts, so
    // every top-level post would otherwise mint a fresh key, read a count of
    // zero, and be admitted — an unbounded loop between two bots talking at
    // top level, which is strictly worse than the room-wide key this
    // replaced. All root posts therefore share one bucket.
    const policy = createA2aRoomPolicy(config(2));
    expect(topLevel(policy, '10.1').action).toBe('admit');
    expect(topLevel(policy, '10.2').action).toBe('admit');
    expect(topLevel(policy, '10.3').action).toBe('drop');
  });

  it('a human speaking clears every thread in the room', () => {
    const policy = createA2aRoomPolicy(config(1));
    reply(policy, '2.1', '1.1');
    topLevel(policy, '10.1');
    expect(reply(policy, '2.2', '1.1').action).toBe('drop');

    policy.onHumanInbound?.({
      instanceKey: 'slack',
      platformId: PLATFORM,
      threadId: `${PLATFORM}:1.1`,
      message: message('h.1'),
    });

    expect(reply(policy, '2.3', '1.1').action).toBe('admit');
    expect(topLevel(policy, '10.2').action).toBe('admit');
  });

  it('does not consume budget for a message downstream never accepted', () => {
    // `onAccepted` is the accounting hook precisely so a message that threw
    // on the way to a session costs nothing.
    const policy = createA2aRoomPolicy(config(1));
    const decision = policy.decideBotInbound({
      instanceKey: 'slack',
      platformId: PLATFORM,
      threadId: `${PLATFORM}:1.1`,
      message: message('2.1'),
      botId: 'B123',
    });
    expect(decision.action).toBe('admit');
    // Deliberately NOT calling onAccepted — downstream rejected it.
    expect(reply(policy, '2.2', '1.1').action).toBe('admit');
  });
});
