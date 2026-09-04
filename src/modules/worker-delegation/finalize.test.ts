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

const { delivered } = vi.hoisted(() => ({
  delivered: [] as Array<{ agentGroupId: string; sessionId: string; text: string; sender: string }>,
}));

vi.mock('./notify.js', () => ({
  deliverToSession: (agentGroupId: string, sessionId: string, text: string, sender: string) => {
    delivered.push({ agentGroupId, sessionId, text, sender });
    return Promise.resolve();
  },
  notifyRequester: vi.fn().mockResolvedValue(undefined),
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

  it('is a no-op on a session with no running task', async () => {
    expect(await finalizeWorkerTaskIfRunning('sess-nobody', 'session-ended')).toBe(false);
    expect(delivered).toHaveLength(0);
  });

  it('never overwrites the draft of a task that has already been answered', async () => {
    await createTask(aRunningTask());
    await setDraftAnswer('wt-1', 'the answer');
    await finalizeWorkerTaskIfRunning('sess-helper', 'done');

    await setDraftAnswer('wt-1', 'a later stray turn');
    expect((await getTask('wt-1'))?.draft_answer).toBe('the answer');
  });
});
