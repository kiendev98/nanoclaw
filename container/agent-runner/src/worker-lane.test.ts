/**
 * A session with no channel of its own gets no auto-delivery lane: an
 * unwrapped turn is always nudged, never silently delivered.
 *
 * This used to have an exception. A repo-worker session — the delivery
 * action that minted a separate agent group per (repo, thread) pair, since
 * removed — had the host write its session routing as an agent-to-agent lane
 * to its orchestrator, and an unwrapped turn went down that lane instead of
 * being nudged. That mechanism is gone along with the worker feature — every
 * session now keeps the nudge, where "which destination?" is a real question
 * the model has to answer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { categorizeMessage, type RoutingContext } from './formatter.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';
import type { MessageInRow } from './db/messages-in.js';

const CHANNEL_ROUTING: RoutingContext = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  taskRun: false,
};

function seedSessionRouting(channelType: string | null, platformId: string | null): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  db.prepare(
    'INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, NULL)',
  ).run(channelType, platformId);
}

function seedChannelDestination(): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-main', 'discord-main', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
}

function makeStubQuery(events: AsyncGenerator<ProviderEvent>): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events,
      abort: () => {},
    },
  };
}

function bareTurn(text: string): AsyncGenerator<ProviderEvent> {
  return (async function* () {
    yield { type: 'init', continuation: 's1' } as ProviderEvent;
    yield { type: 'result', text } as ProviderEvent;
  })();
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('sessions with a channel keep the nudge', () => {
  it('still nudges an unwrapped result and delivers nothing', async () => {
    seedSessionRouting('discord', 'chan-1');
    seedChannelDestination();
    const { query, pushes } = makeStubQuery(bareTurn('bare final text'));

    await processQuery(query, CHANNEL_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('was not delivered');
  });

  it('nudges a session with no routing at all rather than inventing a lane', async () => {
    seedSessionRouting(null, null);
    seedChannelDestination();
    const { query, pushes } = makeStubQuery(bareTurn('bare final text'));

    await processQuery(query, CHANNEL_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(1);
  });
});

describe('a slash-command brief survives an agent-to-agent hop', () => {
  it('dispatches as a real command rather than arriving as prose', async () => {
    // An a2a message delivers `task` as an ordinary chat row, and
    // `formatMessagesWithCommands` hands a passthrough command STRAIGHT to the
    // SDK. Wrap, quote or prefix it anywhere along the way and it silently
    // degrades to prose — the receiving agent then improvises a plausible
    // answer instead of running the command.
    const brief = {
      id: 'a2a-1',
      kind: 'chat',
      channel_type: 'agent',
      platform_id: 'ag-orch',
      content: JSON.stringify({ text: '/blueprint FMTA-343' }),
    } as MessageInRow;

    const info = categorizeMessage(brief);

    expect(info.category).toBe('passthrough');
    expect(info.command).toBe('/blueprint');
    expect(info.text).toBe('/blueprint FMTA-343');
  });

  it('leaves an ordinary prose brief as prose', async () => {
    const brief = {
      id: 'a2a-2',
      kind: 'chat',
      channel_type: 'agent',
      platform_id: 'ag-orch',
      content: JSON.stringify({ text: 'Audit the gates and report what fails.' }),
    } as MessageInRow;

    expect(categorizeMessage(brief).category).toBe('none');
  });
});
