/**
 * A blocked tool holds the poller back, and claims its own answer.
 *
 * The poller's ordinary job is to push new inbound rows into the LIVE query so
 * a running turn sees them. Do that while `ask_user_question` is blocked and
 * the model is handed an answer it cannot act on — it is waiting on a tool
 * result, not on a message — and the tool then times out having never seen it.
 * Same message, two doors, and only one of them reaches a model that can use
 * it.
 *
 * The poll loop's whole part in this is `isToolAwaitingInbound()`: hold the
 * push for one tick. It does not know the question id, which message
 * qualifies, or how to claim one. An earlier revision put all of that in the
 * poll loop and had it write the answer into a second state key — a mailbox
 * with no proof its reader still existed. These tests pin the properties that
 * replaced it.
 *
 * The tool's half — sending the question, claiming the reply, returning it —
 * is in `mcp-tools/escalated-question.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { markAwaitingInbound, clearAwaitingInbound, isToolAwaitingInbound } from './db/session-state.js';
import { findEscalatedAnswers, markCompleted } from './db/messages-in.js';

const QUESTION_ID = 'msg-1788411969-abc123';
const BEFORE_ALL = '2020-01-01T00:00:00.000Z';

/** A real pending inbound row — the claim writes against rows that exist. */
function inbound(id: string, opts: { kind?: string; text?: string; at?: string; seq?: number } = {}): void {
  getInboundDb()
    .prepare(
      `INSERT OR REPLACE INTO messages_in (id, seq, kind, timestamp, status, content, channel_type, platform_id)
       VALUES ($id, $seq, $kind, $timestamp, 'pending', $content, 'agent', 'ag-orchestrator')`,
    )
    .run({
      $id: id,
      $seq: opts.seq ?? 3,
      $kind: opts.kind ?? 'chat',
      $timestamp: opts.at ?? new Date().toISOString(),
      $content: JSON.stringify({ text: opts.text ?? 'Delete it' }),
    });
}

function statusOf(id: string): string | undefined {
  const row = getInboundDb().prepare('SELECT status FROM messages_in WHERE id = ?').get(id) as
    | { status: string }
    | undefined;
  return row?.status;
}

/** Backdate the liveness flag, standing in for a container killed mid-wait. */
function ageFlagBy(ms: number): void {
  getOutboundDb()
    .prepare("UPDATE session_state SET updated_at = ? WHERE key = 'awaiting_inbound'")
    .run(new Date(Date.now() - ms).toISOString());
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('the poll loop holds only while a tool is actually alive', () => {
  it('does not hold when no tool is waiting', () => {
    expect(isToolAwaitingInbound()).toBe(false);
  });

  it('holds while a tool has said so recently', () => {
    markAwaitingInbound(QUESTION_ID);
    expect(isToolAwaitingInbound()).toBe(true);
  });

  it('stops holding once the tool stops saying so', () => {
    // The waiting tool refreshes this every second, so a flag that has gone
    // quiet means the tool is gone — a SIGKILLed container, most often.
    markAwaitingInbound(QUESTION_ID);
    ageFlagBy(10_000);

    expect(isToolAwaitingInbound()).toBe(false);
  });

  it('releases immediately when the tool returns', () => {
    markAwaitingInbound(QUESTION_ID);
    clearAwaitingInbound();

    expect(isToolAwaitingInbound()).toBe(false);
  });

  it('leaves a message untouched when the waiter died', () => {
    // THE REGRESSION THIS RESTRUCTURE EXISTS FOR. The old design had the poll
    // loop write the answer into a state key and ACK the row. With a stale
    // flag and no reader, that message was consumed and destroyed — silently,
    // for up to thirty minutes after any hard kill. Nothing consumes here but
    // the tool itself, so a dead waiter costs nothing.
    markAwaitingInbound(QUESTION_ID);
    ageFlagBy(10_000);
    inbound('a2a-1');

    expect(isToolAwaitingInbound()).toBe(false);
    expect(statusOf('a2a-1')).toBe('pending');
    expect(findEscalatedAnswers(BEFORE_ALL).map((m) => m.id)).toEqual(['a2a-1']);
  });
});

describe('which messages a waiting tool may claim', () => {
  it('offers a pending chat message', () => {
    inbound('a2a-1');
    expect(findEscalatedAnswers(BEFORE_ALL).map((m) => m.id)).toEqual(['a2a-1']);
  });

  it('offers chat-sdk too, which is the same message in a richer envelope', () => {
    inbound('a2a-1', { kind: 'chat-sdk' });
    expect(findEscalatedAnswers(BEFORE_ALL).map((m) => m.id)).toEqual(['a2a-1']);
  });

  it('ignores a system row, which belongs to another waiter', () => {
    // `question_response` is how the CHANNEL path answers, and it has its own
    // finder. Claiming one here would steal it from `askHuman`.
    inbound('sys-1', { kind: 'system' });
    expect(findEscalatedAnswers(BEFORE_ALL)).toEqual([]);
  });

  it('ignores anything that arrived before the question was sent', () => {
    // A message the orchestrator wrote before it could have seen the question
    // is a second instruction queued during the turn, not a reply to it.
    inbound('a2a-early', { at: '2021-06-01T00:00:00.000Z' });
    expect(findEscalatedAnswers('2022-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('stops offering a message once it has been claimed', () => {
    // The claim ledger is `processing_ack`, which the poll loop also reads —
    // so the two cannot both take the same row.
    inbound('a2a-1');
    markCompleted(['a2a-1']);

    expect(findEscalatedAnswers(BEFORE_ALL)).toEqual([]);
  });

  it('offers several in arrival order, so the caller can skip one', () => {
    // A file the orchestrator sent while this was blocked carries no text.
    // The tool passes over it rather than claiming it, which is only possible
    // because the store hands back every candidate.
    inbound('a2a-1', { seq: 3, text: '' });
    inbound('a2a-2', { seq: 5, text: 'Delete it' });

    expect(findEscalatedAnswers(BEFORE_ALL).map((m) => m.id)).toEqual(['a2a-1', 'a2a-2']);
  });
});
