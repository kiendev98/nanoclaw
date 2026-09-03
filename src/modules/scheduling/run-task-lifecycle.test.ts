/**
 * When a `run_task` caller is told, and how a blocked run gets unblocked.
 *
 * Both behaviours here were found by running the thing, not by the suite, and
 * both fail silently:
 *
 * - A run that ends a turn with subagents still working is NOT finished. The
 *   host used to answer the waiter with that interim text, so a live run
 *   reported "still exploring" as its result and everything after — including
 *   the rate-limit error that killed it — reached nobody.
 * - A task session is headless. Its question card is addressed from its own
 *   routing, which is empty until it has posted something, so a question from
 *   a run that had not yet spoken was recorded, dropped, and timed out.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-run-task-lifecycle',
    GROUPS_DIR: '/tmp/nanoclaw-test-run-task-lifecycle/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-run-task-lifecycle';

import { createAgentGroup, closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createPendingQuestion, findSystemSession, getSession, taskThreadId } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSession, resolveTaskSession } from '../../session-manager.js';
import { workspaceSeriesId } from './create.js';
import type { PendingRunRequest } from './run-task.js';
import {
  answerAbandonedRunRequests,
  answerTaskQuestion,
  recordInterimRunSummary,
  relayQuestionToRequester,
  runTask,
} from './run-task.js';

function now(): string {
  return new Date().toISOString();
}

function inboundText(agentGroupId: string, sessionId: string): string {
  const db = new Database(inboundDbPath(agentGroupId, sessionId));
  const rows = db.prepare(`SELECT content FROM messages_in ORDER BY seq`).all() as Array<{ content: string }>;
  db.close();
  return rows.map((r) => r.content).join(' ');
}

async function seedAgent(): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
}

/** A caller that started a run and is parked waiting on it. */
async function startRun(requestId?: string) {
  await seedAgent();
  const { session } = await resolveSession('ag-1', null, null, 'agent-shared');
  await runTask({ instruction: 'work', ...(requestId ? { requestId } : {}), runId: 'run-1' }, session);
  const seriesId = workspaceSeriesId(null, session.id);
  const task = (await findSystemSession('ag-1', taskThreadId(seriesId)))!;
  return { requester: session, task };
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('a waiter is released only by a final turn', () => {
  it('keeps the waiter parked on an interim turn, and carries its text forward', async () => {
    const { task } = await startRun('req-1');

    await recordInterimRunSummary(task, 'still exploring');

    const after = await getSession(task.id);
    const waiters = JSON.parse(after!.pending_run_request!) as PendingRunRequest[];
    expect(waiters).toHaveLength(1);
    expect(waiters[0]!.requestId).toBe('req-1');
    expect(waiters[0]!.lastSummary).toBe('still exploring');
  });

  it('releases a parked waiter when the spent session closes, quoting the interim text', async () => {
    const { requester, task } = await startRun('req-1');
    await recordInterimRunSummary(task, 'hit the session limit');

    // The backstop. Gating alone would leave this caller waiting forever,
    // because the run died before it ever produced a final turn.
    await answerAbandonedRunRequests((await getSession(task.id))!);

    expect((await getSession(task.id))!.pending_run_request).toBeNull();
    expect(inboundText('ag-1', requester.id)).toContain('hit the session limit');
  });

  it('still answers a caller when the run died having reported nothing', async () => {
    const { requester, task } = await startRun('req-1');

    await answerAbandonedRunRequests(task);

    expect(inboundText('ag-1', requester.id)).toContain('without reporting a result');
  });
});

describe('a blocked run asks through whoever started it', () => {
  const question = {
    questionId: 'q-1',
    title: 'Pick one',
    question: 'Which branch?',
    options: [
      { label: 'A', value: 'a' },
      { label: 'B', value: 'b' },
    ],
  };

  it('relays the question, its options and the tool to answer with', async () => {
    const { requester, task } = await startRun('req-1');

    expect(await relayQuestionToRequester((await getSession(task.id))!, question)).toBe(true);

    const text = inboundText('ag-1', requester.id);
    expect(text).toContain('q-1');
    expect(text).toContain('Which branch?');
    expect(text).toContain('answer_task_question');
    // The requester must not invent an answer on the human's behalf.
    expect(text).toContain('Do not answer on their behalf');
  });

  it('does not relay a fire-and-forget run’s question — nobody is listening', async () => {
    const { task } = await startRun();

    // False means "fall through to the channel path", not "swallowed".
    expect(await relayQuestionToRequester(task, question)).toBe(false);
  });

  it('refuses an answer from a session that did not start the run', async () => {
    const { task } = await startRun('req-1');
    await createPendingQuestion({
      question_id: 'q-1',
      session_id: task.id,
      message_out_id: 'm-1',
      platform_id: null,
      channel_type: null,
      thread_id: null,
      title: 'Pick one',
      options: [{ label: 'A', value: 'a' }],
      created_at: now(),
    });

    // A genuinely different session in the same group. `agent-shared` collapses
    // to ONE session whatever thread id it is given, so asking for that mode
    // again would hand back the requester itself and prove nothing.
    const stranger = (await resolveTaskSession('ag-1', 'unrelated-series')).session;
    expect(stranger.id).not.toBe(task.id);
    await answerTaskQuestion({ questionId: 'q-1', answer: 'a' }, stranger);

    // Refused, and told why — a silent no-op would leave the stranger
    // believing it had unblocked a run it has no part in.
    expect(inboundText('ag-1', stranger.id)).toContain('a run you did not start');
    // And the question is still open for its real owner.
    const inDb = new Database(inboundDbPath('ag-1', task.id));
    const responses = inDb
      .prepare(`SELECT content FROM messages_in WHERE content LIKE '%question_response%'`)
      .all() as unknown[];
    inDb.close();
    expect(responses).toHaveLength(0);
  });
});
