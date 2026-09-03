/**
 * A session with no channel asks its orchestrator, not a human who is not there.
 *
 * The bug this closes was silent three times over. A worker's question card
 * went down the agent lane, where `performAgentRoute` copies it into the
 * orchestrator as kind `chat` and the formatter renders `content.text` — which
 * a card does not carry, so the orchestrator woke to an EMPTY message. The host
 * never wrote the `pending_questions` row, because that code sits past
 * delivery.ts's `channel_type === 'agent'` early return, so no button existed
 * anywhere. And the tool then polled for five minutes for a response that could
 * not arrive.
 *
 * There is no pairing poll-loop test any more, and its absence is the point.
 * The answer used to arrive as an ordinary `chat` row, so the loop had to be
 * told to stop pushing while a tool waited, and the tool had to guess which
 * message was its answer. `answer_worker` makes the answer a
 * `question_response` system row, which the loop already filters out by kind —
 * so neither the hold nor the guess exists to test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import {
  setCurrentInReplyTo,
  clearCurrentInReplyTo,
} from '../db/session-state.js';
import { askUserQuestion, renderEscalatedQuestion, sendCard } from './interactive.js';

function outbound(): Array<{
  id: string;
  kind: string;
  channel_type: string | null;
  content: Record<string, unknown>;
}> {
  return (
    getOutboundDb().prepare('SELECT id, kind, channel_type, content FROM messages_out ORDER BY seq').all() as Array<{
      id: string;
      kind: string;
      channel_type: string | null;
      content: string;
    }>
  ).map((r) => ({ id: r.id, kind: r.kind, channel_type: r.channel_type, content: JSON.parse(r.content) }));
}

/** Read back the address on one outbound row — `outbound()` does not carry it. */
function inReplyToOf(id: string): string | null {
  const row = getOutboundDb().prepare('SELECT in_reply_to FROM messages_out WHERE id = ?').get(id) as
    | { in_reply_to: string | null }
    | undefined;
  return row?.in_reply_to ?? null;
}

function seedSessionRouting(channelType: string | null, platformId: string | null, threadId: string | null): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  db.prepare(
    'INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)',
  ).run(channelType, platformId, threadId);
}

/** The lane a repo worker answers on: the orchestrator's agent group, no thread. */
function workerLane(): void {
  seedSessionRouting('agent', 'ag-orchestrator', null);
}

/** An ordinary session, which has a human it can reach. */
function channelLane(): void {
  seedSessionRouting('slack', 'slack:C0ACWUFB44F', 'slack:C0ACWUFB44F:1788411969.598739');
}

const ARGS = {
  title: 'Legacy migration',
  question: 'Delete the legacy 027 migration, or keep it?',
  options: ['Delete it', 'Keep it'],
  // Short so the timeout path is a test, not a wait. Production defaults are
  // 300s on a channel and 600s on the agent lane.
  timeout: 0.05,
};

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('the lane decides who is asked', () => {
  it('sends readable prose down the agent lane, not a card', async () => {
    workerLane();

    await askUserQuestion.handler(ARGS);

    const [msg] = outbound();
    expect(msg.channel_type).toBe('agent');
    // `chat`, because on this lane it IS prose. Claiming `chat-sdk` is what
    // made the old failure invisible — nothing on this lane renders a card.
    expect(msg.kind).toBe('chat');
    expect(typeof msg.content.text).toBe('string');
    // The empty-message bug, stated as an assertion: whatever else changes,
    // this row must carry text the formatter can render.
    expect((msg.content.text as string).length).toBeGreaterThan(0);
    expect(msg.content.text as string).toContain('Delete it');
    expect(msg.content.text as string).toContain('Keep it');
  });

  it('still posts a card when a human is reachable', async () => {
    channelLane();

    await askUserQuestion.handler(ARGS);

    const [msg] = outbound();
    expect(msg.kind).toBe('chat-sdk');
    expect(msg.content.type).toBe('ask_question');
    expect(msg.content.questionId).toBe(msg.id);
    // The host keys `pending_questions` off these, so the card path must be
    // byte-for-byte what it always was.
    expect(msg.content.options).toEqual([
      { label: 'Delete it', selectedLabel: 'Delete it', value: 'Delete it' },
      { label: 'Keep it', selectedLabel: 'Keep it', value: 'Keep it' },
    ]);
  });

  it('keeps the channel thread, so the card lands in the conversation', async () => {
    channelLane();

    await askUserQuestion.handler(ARGS);

    const row = getOutboundDb().prepare('SELECT thread_id FROM messages_out').get() as { thread_id: string | null };
    expect(row.thread_id).toBe('slack:C0ACWUFB44F:1788411969.598739');
  });

  it('treats an agent lane with no platform id as no lane at all', async () => {
    // Routing written but incomplete — there is no orchestrator to escalate
    // to, so this must not silently become an escalation addressed at null.
    seedSessionRouting('agent', null, null);

    await askUserQuestion.handler(ARGS);

    expect(outbound()[0].kind).toBe('chat-sdk');
  });
});

describe('the escalated question text', () => {
  const options = [
    { label: 'Delete it', selectedLabel: 'Delete it', value: 'Delete it' },
    { label: 'Keep it', selectedLabel: 'Keep it', value: 'Keep it' },
  ];

  it('offers the values, which are what an answer must match', () => {
    const text = renderEscalatedQuestion('Legacy migration', 'Delete or keep?', options);
    expect(text).toContain('- Delete it');
    expect(text).toContain('- Keep it');
  });

  it('names the tool that answers it', () => {
    // An ordinary message reaches the worker as new work and leaves it
    // blocked, so the orchestrator has to be told which door to use.
    expect(renderEscalatedQuestion('t', 'q', options)).toContain('answer_worker');
  });

  it('says the asker cannot reach a person', () => {
    // Otherwise the obvious reading of "ask the user" is that the worker
    // already did, and the orchestrator answers as a bystander.
    expect(renderEscalatedQuestion('t', 'q', options)).toContain('cannot reach a person');
  });
});

describe('waiting for the orchestrator', () => {
  /** The question id the tool minted, read back off its own outbound row. */
  function askedQuestionId(): string {
    return outbound()[0].id;
  }

  /**
   * The answer, in the shape `answer_worker` makes the host write.
   *
   * A `question_response` system row — byte-identical to what a button click
   * produces on a channel, which is what lets one wait serve both lanes.
   */
  function answer(text: string, questionId: string): void {
    getInboundDb()
      .prepare(
        `INSERT OR REPLACE INTO messages_in (id, seq, kind, timestamp, status, content, channel_type, platform_id)
         VALUES ($id, 3, 'system', $timestamp, 'pending', $content, 'agent', 'ag-orchestrator')`,
      )
      .run({
        $id: `qr-${questionId}`,
        $timestamp: new Date().toISOString(),
        $content: JSON.stringify({ type: 'question_response', questionId, selectedOption: text, userId: '' }),
      });
  }

  /** An ordinary message from the orchestrator, arriving mid-wait. */
  function chat(text: string, id: string): void {
    getInboundDb()
      .prepare(
        `INSERT OR REPLACE INTO messages_in (id, seq, kind, timestamp, status, content, channel_type, platform_id)
         VALUES ($id, 5, 'chat', $timestamp, 'pending', $content, 'agent', 'ag-orchestrator')`,
      )
      .run({ $id: id, $timestamp: new Date().toISOString(), $content: JSON.stringify({ text }) });
  }

  function ackStatus(id: string): string | undefined {
    const row = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
      | { status: string }
      | undefined;
    return row?.status;
  }

  it('carries the question alongside the prose, so the host can record it', async () => {
    // Two readers, one row: `text` for the orchestrator's formatter, which
    // renders nothing else, and `question` for delivery.ts — which is the only
    // place that can create the pending row on this lane.
    workerLane();

    await askUserQuestion.handler(ARGS);

    const [row] = outbound();
    const question = row.content.question as { id: string; title: string; options: unknown[] };
    expect(typeof row.content.text).toBe('string');
    expect(question.id).toBe(row.id);
    expect(question.title).toBe('Legacy migration');
    // `pending_questions` requires both, and this lane has no card to read
    // them from.
    expect(question.options).toHaveLength(2);
  });

  it('returns the orchestrator answer as its own result', async () => {
    workerLane();

    const pending = askUserQuestion.handler({ ...ARGS, timeout: 5 });
    await new Promise((r) => setTimeout(r, 10));
    answer('Delete it', askedQuestionId());
    const result = await pending;

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toBe('Delete it');
  });

  it('claims the response, so the model never sees it twice', async () => {
    // Claimed through `processing_ack` — the same ledger the poll loop reads.
    workerLane();

    const pending = askUserQuestion.handler({ ...ARGS, timeout: 5 });
    await new Promise((r) => setTimeout(r, 10));
    const id = askedQuestionId();
    answer('Delete it', id);
    await pending;

    expect(ackStatus(`qr-${id}`)).toBe('completed');
  });

  it('is not answered by an ordinary message sent during the wait', async () => {
    // THE REGRESSION THIS REPLACED. The tool used to take the first message
    // carrying text, so "also bump the dep" sent during the same turn was
    // silently relabelled as the decision and the real answer arrived too
    // late. Now that message is left pending for the model, and only a
    // question_response ends the wait.
    workerLane();

    const pending = askUserQuestion.handler({ ...ARGS, timeout: 5 });
    await new Promise((r) => setTimeout(r, 10));
    chat('also bump the dep', 'a2a-more-work');
    await new Promise((r) => setTimeout(r, 20));
    answer('Delete it', askedQuestionId());
    const result = await pending;

    expect((result.content[0] as { text: string }).text).toBe('Delete it');
    expect(ackStatus('a2a-more-work')).toBeUndefined();
  });

  it("is not answered by a response to somebody else's question", async () => {
    workerLane();

    const pending = askUserQuestion.handler({ ...ARGS, timeout: 0.3 });
    await new Promise((r) => setTimeout(r, 10));
    answer('Delete it', 'msg-someone-else');
    const result = await pending;

    expect(result.isError).toBe(true);
  });

  it('tells the caller the failure is not worth repeating', async () => {
    workerLane();

    const result = await askUserQuestion.handler(ARGS);

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('orchestrator did not answer');
    // A second question would wait behind the same silence.
    expect(text).toContain('Do not ask again');
  });
});

describe('send_card on a lane with no renderer', () => {
  it('sends the fallback text so the orchestrator does not get an empty message', async () => {
    workerLane();

    await sendCard.handler({ card: { title: 'Build' }, fallbackText: 'Build finished: 0 failures' });

    const [msg] = outbound();
    expect(msg.kind).toBe('chat');
    expect(msg.content.text).toBe('Build finished: 0 failures');
  });

  it('says a card was sent when the caller supplied no fallback', async () => {
    // Better a sentence than the empty message this whole file exists about.
    workerLane();

    await sendCard.handler({ card: { title: 'Build' } });

    expect(outbound()[0].content.text as string).toContain('no text fallback');
  });

  it('still sends a real card on a channel', async () => {
    channelLane();

    await sendCard.handler({ card: { title: 'Build' }, fallbackText: 'done' });

    const [msg] = outbound();
    expect(msg.kind).toBe('chat-sdk');
    expect(msg.content.type).toBe('card');
    expect(msg.content.card).toEqual({ title: 'Build' });
  });
});

describe('the question is addressed to the session that briefed this worker', () => {
  it('stamps in_reply_to, so peer affinity does not pick the wrong session', async () => {
    // `resolveTargetSession` falls back to "whichever of the orchestrator's
    // sessions last spoke to this worker" when nothing is addressed.
    // Destinations are group-scoped, so a scheduled task or a second thread
    // can be that session — and it may hold a thread binding of its own, which
    // would surface the question inside an unrelated human thread.
    workerLane();
    setCurrentInReplyTo('msg-the-brief');

    await askUserQuestion.handler(ARGS);

    expect(inReplyToOf(outbound()[0].id)).toBe('msg-the-brief');
  });

  it('sends unaddressed rather than not at all when there is no stamp', async () => {
    // A question escalated outside a batch — the stamp aged out, or the tool
    // ran from a wake with nothing to reply to. Peer affinity is then the only
    // route there is, and it is usually right. Refusing to ask would be worse.
    workerLane();
    clearCurrentInReplyTo();

    await askUserQuestion.handler(ARGS);

    expect(inReplyToOf(outbound()[0].id)).toBeNull();
  });
});
