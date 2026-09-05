import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { writeMessageOut } from './db/messages-out.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

const ROUTING = {
  channelType: 'discord',
  platformId: 'chan-1',
  threadId: null,
  taskRun: false,
};

beforeEach(() => {
  initTestSessionDb();
  process.env.NANOCLAW_WORKER_SESSION = '1';
});

afterEach(() => {
  delete process.env.NANOCLAW_WORKER_SESSION;
  closeSessionDb();
});

function lendConversation(): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('conversation-1', 'conversation-1', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
}

/**
 * A turn ending in bare text, optionally preceded by the worker's own report.
 *
 * The report has to be written between the init and the result, because the
 * turn's high-water mark is read at the init: a row written before the call
 * sits below it and reads as belonging to an earlier turn.
 */
function makeWorkerTurn(
  text: string,
  before?: { action: string; text: string },
): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    if (before) {
      await writeMessageOut({ id: 'before-1', kind: 'system', content: JSON.stringify(before) });
    }
    yield { type: 'result', text };
  }
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    },
  };
}

/**
 * A worker's bare final text is its report, and nudging it toward a
 * `<message to="...">` block coaxes it at a door it does not hold. That
 * suppression has to stay narrow: two worker turns are ordinary undelivered
 * turns, and swallowing either loses the text with only a scratchpad line.
 */
describe('worker wrap-nudge suppression', () => {
  it('nudges a worker holding a lent conversation that has not reported yet', async () => {
    lendConversation();
    const { query, pushes } = makeWorkerTurn('Here is the answer for the reviewer.');

    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('conversation-1');
  });

  it('leaves a worker that reported this turn alone, lent conversation or not', async () => {
    lendConversation();
    const { query, pushes } = makeWorkerTurn('Task reported. Gate open at PR #9.', {
      action: 'worker_done',
      text: 'Task reported. Gate open at PR #9.',
    });

    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(pushes).toHaveLength(0);
  });

  it('leaves a worker holding no destination alone, reported or not', async () => {
    const { query, pushes } = makeWorkerTurn('Still exploring the failing test.');

    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(pushes).toHaveLength(0);
  });

  // Every worker action carries the same row shape, and a progress note carries
  // agent-authored prose in it. A note that quotes the tool name must not read
  // as the report — that would swallow the very turn it belongs to.
  it('does not read a progress note quoting the report action as the report', async () => {
    lendConversation();
    const { query, pushes } = makeWorkerTurn('Here is the answer for the reviewer.', {
      action: 'worker_progress_note',
      text: 'About to call "worker_done" once the gate clears.',
    });

    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(pushes).toHaveLength(1);
  });
});
