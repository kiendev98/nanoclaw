/**
 * One answer per task, and it is the host that sends it.
 *
 * These drive the real status transition against a real database, because the
 * transition IS the guarantee: two callers race on every task — the helper's
 * own `finish_task` and the terminal event behind it — and exactly one may
 * deliver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

const { delivered, failNextDelivery } = vi.hoisted(() => ({
  delivered: [] as Array<{ agentGroupId: string; sessionId: string; text: string; sender: string }>,
  failNextDelivery: { value: false },
}));

vi.mock('./notify.js', () => ({
  deliverToSession: (agentGroupId: string, sessionId: string, text: string, sender: string) => {
    if (failNextDelivery.value) {
      failNextDelivery.value = false;
      return Promise.reject(new Error('the principal session is gone'));
    }
    delivered.push({ agentGroupId, sessionId, text, sender });
    return Promise.resolve();
  },
  replyToCaller: vi.fn().mockResolvedValue(undefined),
}));

const { createTask, getTask, setDraftAnswer } = await import('./db/worker-tasks.js');
const { finalizeWorkerTaskIfRunning } = await import('./finalize.js');
import type { WorkerTask } from './types.js';

function aRunningTask(overrides: Partial<WorkerTask> = {}): WorkerTask {
  return {
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
    ...overrides,
  };
}

beforeEach(async () => {
  delivered.length = 0;
  failNextDelivery.value = false;
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

describe('finalizeWorkerTaskIfRunning', () => {
  it('delivers the last draft to the principal, naming the worker and its repository', async () => {
    await createTask(aRunningTask());
    await setDraftAnswer('wt-1', 'first attempt');
    await setDraftAnswer('wt-1', 'opened PR #482');

    expect(await finalizeWorkerTaskIfRunning('sess-helper', 'done')).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.sessionId).toBe('sess-principal');
    expect(delivered[0]!.sender).toBe('nanoclaw-worker');
    expect(delivered[0]!.text).toContain('opened PR #482');
    expect(delivered[0]!.text).not.toContain('first attempt');
    expect(delivered[0]!.text).toContain('nanoclaw');
  });

  it('reports that the run did not complete when it left no statement', async () => {
    await createTask(aRunningTask());

    expect(await finalizeWorkerTaskIfRunning('sess-helper', 'session-ended')).toBe(true);
    expect(delivered[0]!.text).toContain('did not complete');
  });

  it('delivers exactly once when the tool and the terminal event both fire', async () => {
    await createTask(aRunningTask());
    await setDraftAnswer('wt-1', 'done');

    const [first, second] = await Promise.all([
      finalizeWorkerTaskIfRunning('sess-helper', 'done'),
      finalizeWorkerTaskIfRunning('sess-helper', 'session-ended'),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect((await getTask('wt-1'))?.status).toBe('answered');
  });

  // A helper session is REUSED for a second task in the same thread. Without
  // the fence, the second row would hide the first from every later lookup,
  // and the first principal — promised one report — would get none.
  it('refuses a second running task on one helper session', async () => {
    await createTask(aRunningTask());
    await expect(createTask(aRunningTask({ task_id: 'wt-2' }))).rejects.toThrow();

    await finalizeWorkerTaskIfRunning('sess-helper', 'done');
    await createTask(aRunningTask({ task_id: 'wt-2' }));
    expect((await getTask('wt-2'))?.status).toBe('running');
  });

  it('is a no-op on a session with no running task', async () => {
    expect(await finalizeWorkerTaskIfRunning('sess-nobody', 'session-ended')).toBe(false);
    expect(delivered).toHaveLength(0);
  });

  // The claim has to precede the delivery, so a delivery that fails after it
  // would turn "exactly one report" into none — the failure mode the whole
  // backstop exists to prevent.
  it('hands the claim back when delivery fails, so the backstop can try again', async () => {
    await createTask(aRunningTask());
    await setDraftAnswer('wt-1', 'opened PR #482');

    failNextDelivery.value = true;
    expect(await finalizeWorkerTaskIfRunning('sess-helper', 'done')).toBe(false);
    expect(delivered).toHaveLength(0);
    expect((await getTask('wt-1'))?.status).toBe('running');

    expect(await finalizeWorkerTaskIfRunning('sess-helper', 'session-ended')).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain('opened PR #482');
  });

  it('keeps the open question through a failed delivery, so a retry still has it', async () => {
    const { createQuestion, findOpenQuestion } = await import('./db/worker-questions.js');
    await createTask(aRunningTask());
    await createQuestion({
      question_id: 'wq-1',
      task_id: 'wt-1',
      helper_session_id: 'sess-helper',
      helper_agent_group_id: 'ag-helper',
      principal_agent_group_id: 'ag-principal',
      principal_session_id: 'sess-principal',
      question_text: 'skip the seed step?',
      created_at: new Date().toISOString(),
    });

    failNextDelivery.value = true;
    await finalizeWorkerTaskIfRunning('sess-helper', 'done');
    expect(await findOpenQuestion('sess-helper')).toBeDefined();

    await finalizeWorkerTaskIfRunning('sess-helper', 'session-ended');
    expect(await findOpenQuestion('sess-helper')).toBeUndefined();
  });

  it('never overwrites the draft of a task that has already been answered', async () => {
    await createTask(aRunningTask());
    await setDraftAnswer('wt-1', 'the answer');
    await finalizeWorkerTaskIfRunning('sess-helper', 'done');

    await setDraftAnswer('wt-1', 'a later stray turn');
    expect((await getTask('wt-1'))?.draft_answer).toBe('the answer');
  });
});
