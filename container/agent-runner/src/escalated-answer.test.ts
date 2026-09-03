/**
 * The orchestrator's reply belongs to the tool that is waiting for it.
 *
 * The poller's ordinary job is to push new inbound rows into the LIVE query so
 * a running turn sees them. Do that while `ask_user_question` is blocked and
 * the model is handed an answer it cannot act on — it is waiting on a tool
 * result, not on a message — and the tool then times out having never seen it.
 * Same message, two doors, and only one of them reaches a model that can use
 * it. `divertAnswerToWaitingTool` is the choice between those doors.
 *
 * The other half — the tool sending the question and taking the answer — is in
 * `mcp-tools/escalated-question.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { setOpenQuestion, getOpenQuestion, takeQuestionAnswer } from './db/session-state.js';
import { divertAnswerToWaitingTool } from './poll-loop.js';
import type { MessageInRow } from './db/messages-in.js';

const QUESTION_ID = 'msg-1788411969-abc123';

function message(overrides: Partial<MessageInRow> = {}): MessageInRow {
  const id = overrides.id ?? 'a2a-1';
  // Real rows, not fakes: the divert marks one completed, and that write has
  // to land on a row that exists.
  getInboundDb()
    .prepare(
      `INSERT OR REPLACE INTO messages_in (id, seq, kind, timestamp, status, content, channel_type, platform_id)
       VALUES ($id, $seq, $kind, $timestamp, 'pending', $content, 'agent', 'ag-orchestrator')`,
    )
    .run({
      $id: id,
      $seq: 3,
      $kind: overrides.kind ?? 'chat',
      $timestamp: new Date().toISOString(),
      $content: overrides.content ?? JSON.stringify({ text: 'Delete it' }),
    });
  return {
    id,
    seq: 3,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    status: 'pending',
    process_after: null,
    recurrence: null,
    series_id: null,
    tries: 0,
    trigger: 1,
    platform_id: 'ag-orchestrator',
    channel_type: 'agent',
    thread_id: null,
    content: JSON.stringify({ text: 'Delete it' }),
    source_session_id: null,
    on_wake: 0,
    ...overrides,
  };
}

function isCompleted(id: string): boolean {
  const row = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
    | { status: string }
    | undefined;
  return row?.status === 'completed';
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('while no question is open', () => {
  it('takes nothing, so ordinary messages reach the model', () => {
    expect(divertAnswerToWaitingTool([message()])).toBe(false);
  });

  it('leaves the message pending for the poller to push', () => {
    divertAnswerToWaitingTool([message()]);
    expect(isCompleted('a2a-1')).toBe(false);
  });
});

describe('while a question is open', () => {
  beforeEach(() => {
    setOpenQuestion(QUESTION_ID);
  });

  it('hands the reply to the waiting tool and closes the question', () => {
    expect(divertAnswerToWaitingTool([message()])).toBe(true);

    expect(takeQuestionAnswer(QUESTION_ID)).toBe('Delete it');
    expect(getOpenQuestion()).toBeNull();
  });

  it('marks the row completed, so it is never replayed as a bare answer', () => {
    // Left pending, the next batch would open with "Delete it" and no question
    // in front of it — and a worker whose transcript was wiped by
    // `freshSessionPerTask` would have no idea what it agreed to.
    divertAnswerToWaitingTool([message()]);

    expect(isCompleted('a2a-1')).toBe(true);
  });

  it('takes only the first message — a question has one answer', () => {
    const taken = divertAnswerToWaitingTool([
      message({ id: 'a2a-1' }),
      message({ id: 'a2a-2', content: JSON.stringify({ text: 'and also check the tests' }) }),
    ]);

    expect(taken).toBe(true);
    expect(takeQuestionAnswer(QUESTION_ID)).toBe('Delete it');
    // The follow-up stays pending and reaches the model on the next tick,
    // by which time the question is closed.
    expect(isCompleted('a2a-2')).toBe(false);
  });

  it('accepts a chat-sdk reply as readily as a chat one', () => {
    expect(divertAnswerToWaitingTool([message({ id: 'a2a-1', kind: 'chat-sdk' })])).toBe(true);
  });

  it('ignores a non-chat row, which is not something anyone said', () => {
    expect(divertAnswerToWaitingTool([message({ id: 'a2a-1', kind: 'task' })])).toBe(false);
    expect(getOpenQuestion()).toBe(QUESTION_ID);
  });

  it('does not answer with an empty message', () => {
    // A blank answer would unblock the tool with nothing, which is worse than
    // waiting — the model would have to guess what was decided.
    expect(divertAnswerToWaitingTool([message({ content: JSON.stringify({ text: '   ' }) })])).toBe(false);
    expect(getOpenQuestion()).toBe(QUESTION_ID);
  });

  it('trims the answer, because a button value never has stray whitespace', () => {
    divertAnswerToWaitingTool([message({ content: JSON.stringify({ text: '  Delete it\n' }) })]);
    expect(takeQuestionAnswer(QUESTION_ID)).toBe('Delete it');
  });

  it('falls back to the raw body when the content is not JSON', () => {
    divertAnswerToWaitingTool([message({ content: 'Delete it' })]);
    expect(takeQuestionAnswer(QUESTION_ID)).toBe('Delete it');
  });
});

describe('the answer slot', () => {
  it('is consumed once, so a late poll cannot re-deliver it', () => {
    setOpenQuestion(QUESTION_ID);
    divertAnswerToWaitingTool([message()]);

    expect(takeQuestionAnswer(QUESTION_ID)).toBe('Delete it');
    expect(takeQuestionAnswer(QUESTION_ID)).toBeUndefined();
  });

  it('keeps an answer addressed to another question rather than dropping it', () => {
    setOpenQuestion(QUESTION_ID);
    divertAnswerToWaitingTool([message()]);

    expect(takeQuestionAnswer('a-different-question')).toBeUndefined();
    // Still there for whoever actually asked.
    expect(takeQuestionAnswer(QUESTION_ID)).toBe('Delete it');
  });
});
