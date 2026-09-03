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
 * The pairing test for the other half — the poller handing the orchestrator's
 * reply to this waiting tool rather than pushing it at the model — lives in
 * `../escalated-answer.test.ts`, because that half belongs to the poll loop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { setQuestionAnswer, getOpenQuestion } from '../db/session-state.js';
import { askUserQuestion, renderEscalatedQuestion, sendCard } from './interactive.js';

function outbound(): Array<{ id: string; kind: string; channel_type: string | null; content: Record<string, unknown> }> {
  return (
    getOutboundDb()
      .prepare('SELECT id, kind, channel_type, content FROM messages_out ORDER BY seq')
      .all() as Array<{ id: string; kind: string; channel_type: string | null; content: string }>
  ).map((r) => ({ id: r.id, kind: r.kind, channel_type: r.channel_type, content: JSON.parse(r.content) }));
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

  it('says the next message is consumed as the answer', () => {
    // Without this line an orchestrator replies "ok, let me check with them"
    // and has spent the answer on an acknowledgement.
    expect(renderEscalatedQuestion('t', 'q', options)).toContain('next message');
  });

  it('says the asker cannot reach a person', () => {
    // Otherwise the obvious reading of "ask the user" is that the worker
    // already did, and the orchestrator answers as a bystander.
    expect(renderEscalatedQuestion('t', 'q', options)).toContain('cannot reach a person');
  });
});

describe('waiting for the orchestrator', () => {
  it('flags the open question so the poller knows to divert the reply', async () => {
    workerLane();
    let observed: string | null = null;

    const pending = askUserQuestion.handler(ARGS);
    // Read it while the tool is still blocked — that is the only window in
    // which the poller ever looks.
    await new Promise((r) => setTimeout(r, 10));
    observed = getOpenQuestion();
    await pending;

    expect(observed).not.toBeNull();
    expect(observed).toBe(outbound()[0].id);
  });

  it('returns the orchestrator answer as its own result', async () => {
    workerLane();

    const pending = askUserQuestion.handler({ ...ARGS, timeout: 5 });
    await new Promise((r) => setTimeout(r, 10));
    setQuestionAnswer(getOpenQuestion()!, 'Delete it');
    const result = await pending;

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toBe('Delete it');
  });

  it('does not take an answer meant for a different question', async () => {
    workerLane();

    const pending = askUserQuestion.handler(ARGS);
    await new Promise((r) => setTimeout(r, 10));
    setQuestionAnswer('some-other-question', 'Delete it');
    const result = await pending;

    expect(result.isError).toBe(true);
  });

  it('releases the lane on timeout, so the next message is not swallowed', async () => {
    // Left flagged, the orchestrator's next ordinary message would be diverted
    // into an answer slot nothing is reading — it would vanish instead of
    // waking this worker.
    workerLane();

    await askUserQuestion.handler(ARGS);

    expect(getOpenQuestion()).toBeNull();
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
