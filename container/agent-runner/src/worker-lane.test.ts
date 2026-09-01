/**
 * A repo worker's reply is delivered BY CODE, not by the worker remembering
 * to address a destination.
 *
 * A worker has no channel of its own, so the host writes its session routing
 * as the agent-to-agent lane to its orchestrator (see
 * `src/session-manager.ts::writeSessionRouting`). This is the container half:
 * a turn that ends in unwrapped text goes down that lane instead of being
 * nudged, and everything WITH a channel keeps the nudge, where "which
 * destination?" is a real question the model has to answer.
 *
 * The failure this closes is silent by construction. Unwrapped text in a
 * channel-less session was scratchpad: nothing delivered, one nudge, and if
 * the model did not re-wrap, the answer was gone with no error anywhere.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { categorizeMessage, type RoutingContext } from './formatter.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';
import type { MessageInRow } from './db/messages-in.js';

/** The routing a brief from the orchestrator arrives on. */
const BRIEF_ROUTING: RoutingContext = {
  platformId: 'ag-orch',
  channelType: 'agent',
  threadId: null,
  inReplyTo: 'a2a-1',
  taskRun: false,
};

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

describe("a worker's plain output reaches its orchestrator", () => {
  it('delivers unwrapped final text down the agent lane, with no send_message call', async () => {
    seedSessionRouting('agent', 'ag-orch');
    const { query, pushes } = makeStubQuery(bareTurn('The gates pass. Three files changed.'));

    await processQuery(query, BRIEF_ROUTING, ['a2a-1'], 'claude', undefined, 'prompt', undefined, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('agent');
    expect(out[0].platform_id).toBe('ag-orch');
    expect(JSON.parse(out[0].content).text).toBe('The gates pass. Three files changed.');
    // Delivered, so there is nothing to nudge about.
    expect(pushes).toHaveLength(0);
  });

  it('addresses the lane from the SESSION routing, not from whoever last wrote to it', async () => {
    // The host fixes the lane at creation from `origin_session_id`. An inbound
    // batch from anyone else must not redirect the worker's answer.
    seedSessionRouting('agent', 'ag-orch');
    const { query } = makeStubQuery(bareTurn('done'));

    await processQuery(
      query,
      { ...BRIEF_ROUTING, platformId: 'ag-someone-else' },
      ['a2a-1'],
      'claude',
      undefined,
      'prompt',
      undefined,
      true,
    );

    expect(getUndeliveredMessages()[0].platform_id).toBe('ag-orch');
  });

  it('stamps in_reply_to so the answer lands in the session that asked', async () => {
    seedSessionRouting('agent', 'ag-orch');
    const { query } = makeStubQuery(bareTurn('done'));

    await processQuery(query, BRIEF_ROUTING, ['a2a-1'], 'claude', undefined, 'prompt', undefined, true);

    expect(getUndeliveredMessages()[0].in_reply_to).toBe('a2a-1');
  });

  it('leaves an addressed reply alone — one delivery, not two', async () => {
    seedSessionRouting('agent', 'ag-orch');
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('parent', 'parent', 'agent', NULL, NULL, 'ag-orch')`,
      )
      .run();
    const events = (async function* () {
      yield { type: 'init', continuation: 's1' } as ProviderEvent;
      yield { type: 'text', text: '<message to="parent">Explicitly addressed.</message>' } as ProviderEvent;
      yield { type: 'result', text: 'Explicitly addressed.' } as ProviderEvent;
    })();
    const { query } = makeStubQuery(events);

    await processQuery(query, BRIEF_ROUTING, ['a2a-1'], 'claude', undefined, 'prompt', undefined, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Explicitly addressed.');
  });
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

describe('a slash-command brief survives the trip into the worker', () => {
  it('dispatches as a real command rather than arriving as prose', async () => {
    // `create_worker` delivers `task` as an ordinary a2a chat row, and
    // `formatMessagesWithCommands` hands a passthrough command STRAIGHT to the
    // SDK. Wrap, quote or prefix it anywhere along the way and it silently
    // degrades to prose — the worker then improvises a plausible answer
    // instead of running the command.
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
