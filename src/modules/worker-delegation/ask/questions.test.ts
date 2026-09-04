/**
 * An answer is a reply to a question, never a new instruction.
 *
 * That invariant is why answering is its own action verified against a question
 * id: with no such check, an ordinary message arriving while a helper waits
 * would be indistinguishable from the answer it waits for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { registerWorkerMigration } from '../db/migrate.js';
import type { Session } from '../../../types.js';

const { delivered, refusals, unreachable } = vi.hoisted(() => ({
  delivered: [] as Array<{ sessionId: string; text: string }>,
  refusals: [] as string[],
  /** Session ids whose delivery reports the target as gone. */
  unreachable: new Set<string>(),
}));

vi.mock('../notify.js', () => ({
  deliverToSession: (_agentGroupId: string, sessionId: string, text: string) => {
    if (unreachable.has(sessionId)) return Promise.resolve(false);
    delivered.push({ sessionId, text });
    return Promise.resolve(true);
  },
  replyToCaller: (_session: Session, text: string) => {
    refusals.push(text);
    return Promise.resolve(true);
  },
}));

const { createTask } = await import('../db/worker-tasks.js');
const { findOpenQuestion } = await import('../db/worker-questions.js');
const { answerWorkerQuestion, askPrincipal } = await import('./questions.js');
import type { WorkerTask } from '../types.js';

const HELPER_SESSION = { id: 'sess-helper', agent_group_id: 'ag-helper' } as Session;
const PRINCIPAL_SESSION = { id: 'sess-principal', agent_group_id: 'ag-principal' } as Session;

const task: WorkerTask = {
  task_id: 'wt-1',
  helper_session_id: 'sess-helper',
  helper_agent_group_id: 'ag-helper',
  repo_name: 'nanoclaw',
  principal_agent_group_id: 'ag-principal',
  principal_session_id: 'sess-principal',
  description: 'add a --dry-run flag',
  status: 'running',
  draft_answer: null,
  progress_note_count: 0,
  last_progress_note_at: null,
  created_at: new Date().toISOString(),
  completed_at: null,
};

async function askOne(question = 'should --dry-run skip the seed step?'): Promise<string> {
  await askPrincipal({ question }, HELPER_SESSION);
  const open = await findOpenQuestion('sess-helper');
  expect(open).toBeDefined();
  return open!.question_id;
}

beforeEach(async () => {
  delivered.length = 0;
  refusals.length = 0;
  unreachable.clear();
  registerWorkerMigration();
  await runMigrations(await initTestDb());
  await createTask(task);
});

afterEach(async () => {
  await closeDb();
});

describe('askPrincipal', () => {
  it('reaches the principal that gave the task, and nobody else', async () => {
    await askOne();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.sessionId).toBe('sess-principal');
    expect(delivered[0]!.text).toContain('should --dry-run skip the seed step?');
  });

  it('refuses a second question while one is open, and says to stop (C9)', async () => {
    await askOne();
    await askPrincipal({ question: 'and the migrations?' }, HELPER_SESSION);

    expect(delivered).toHaveLength(1);
    expect(refusals.at(-1)).toContain('already waiting');
  });

  it('refuses when the session has no running task', async () => {
    await askPrincipal({ question: 'anything?' }, { id: 'sess-other', agent_group_id: 'ag-x' } as Session);
    expect(delivered).toHaveLength(0);
    expect(refusals.at(-1)).toContain('no running task');
  });

  // Nobody can answer a question that reached no one, and C9 forbids asking
  // again. Left open, the helper would wait out its whole bound for an answer
  // that was never coming.
  it('takes the question back when the principal cannot be reached', async () => {
    unreachable.add('sess-principal');

    await askPrincipal({ question: 'should --dry-run skip the seed step?' }, HELPER_SESSION);

    expect(await findOpenQuestion('sess-helper')).toBeUndefined();
    expect(refusals.at(-1)).toContain('no longer reachable');
  });

  it('lets the helper ask again after an undeliverable question', async () => {
    unreachable.add('sess-principal');
    await askPrincipal({ question: 'first' }, HELPER_SESSION);
    unreachable.clear();

    await askPrincipal({ question: 'second' }, HELPER_SESSION);

    expect(delivered.filter((d) => d.sessionId === 'sess-principal')).toHaveLength(1);
    expect(await findOpenQuestion('sess-helper')).toBeDefined();
  });
});

describe('answerWorkerQuestion', () => {
  it('delivers the answer with the original question above it (C8)', async () => {
    const questionId = await askOne();
    await answerWorkerQuestion({ questionId, answer: 'yes, skip it' }, PRINCIPAL_SESSION);

    const toHelper = delivered.find((d) => d.sessionId === 'sess-helper');
    expect(toHelper?.text).toContain('should --dry-run skip the seed step?');
    expect(toHelper?.text).toContain('yes, skip it');
  });

  it('refuses an answer from an agent group the question was not asked of (C5)', async () => {
    const questionId = await askOne();
    await answerWorkerQuestion({ questionId, answer: 'yes' }, {
      id: 'sess-stranger',
      agent_group_id: 'ag-stranger',
    } as Session);

    expect(delivered.some((d) => d.sessionId === 'sess-helper')).toBe(false);
    expect(refusals.at(-1)).toContain('not asked of you');
    expect(await findOpenQuestion('sess-helper')).toBeDefined();
  });

  // One agent group wired into two chats runs two sessions. Only the session
  // that was asked ever saw the question, so the other one answering it would
  // consume a question blind — and the helper would act on it.
  it('refuses an answer from another session of the right agent group (C5)', async () => {
    const questionId = await askOne();
    await answerWorkerQuestion({ questionId, answer: 'yes' }, {
      id: 'sess-principal-other-thread',
      agent_group_id: 'ag-principal',
    } as Session);

    expect(delivered.some((d) => d.sessionId === 'sess-helper')).toBe(false);
    expect(refusals.at(-1)).toContain('not asked of you');
    expect(await findOpenQuestion('sess-helper')).toBeDefined();
  });

  it('answers a question once, and says so on a second attempt', async () => {
    const questionId = await askOne();
    await answerWorkerQuestion({ questionId, answer: 'yes' }, PRINCIPAL_SESSION);
    await answerWorkerQuestion({ questionId, answer: 'no, actually' }, PRINCIPAL_SESSION);

    expect(delivered.filter((d) => d.sessionId === 'sess-helper')).toHaveLength(1);
    expect(refusals.at(-1)).toContain('not open');
  });

  it('requires both a question id and an answer', async () => {
    await answerWorkerQuestion({ questionId: 'wq-1' }, PRINCIPAL_SESSION);
    expect(refusals.at(-1)).toContain('required');
  });

  it('frees the helper to ask again once its question is answered', async () => {
    const questionId = await askOne();
    await answerWorkerQuestion({ questionId, answer: 'yes' }, PRINCIPAL_SESSION);

    await askPrincipal({ question: 'and the migrations?' }, HELPER_SESSION);
    expect(delivered.filter((d) => d.sessionId === 'sess-principal')).toHaveLength(2);
  });
});
