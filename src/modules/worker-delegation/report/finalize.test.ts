/**
 * One answer per task, and it is the host that sends it.
 *
 * These drive the real status transition against a real database, because the
 * transition IS the guarantee: two callers race on every task — the helper's
 * own `finish_task` and the terminal event behind it — and exactly one may
 * deliver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { registerWorkerMigration } from '../db/migrate.js';

const { delivered, failNextDelivery, sessionGone, routed, projected } = vi.hoisted(() => ({
  delivered: [] as Array<{ agentGroupId: string; sessionId: string; text: string; sender: string }>,
  failNextDelivery: { value: false },
  // A throw is transient; `false` is a session that no longer exists. The two
  // must not be handled the same way, so the mock can produce either.
  sessionGone: { value: false },
  routed: [] as Array<{ group: string; session: string }>,
  projected: [] as Array<{ group: string; session: string }>,
}));

vi.mock('../../../session-manager.js', () => ({
  writeSessionRouting: (group: string, session: string) => {
    routed.push({ group, session });
    return Promise.resolve();
  },
}));

vi.mock('../../agent-to-agent/write-destinations.js', () => ({
  writeDestinations: (group: string, session: string) => {
    projected.push({ group, session });
    return Promise.resolve();
  },
}));

vi.mock('../notify.js', () => ({
  deliverToSession: (agentGroupId: string, sessionId: string, text: string, sender: string) => {
    if (failNextDelivery.value) {
      failNextDelivery.value = false;
      return Promise.reject(new Error('the mailbox write failed'));
    }
    if (sessionGone.value) return Promise.resolve(false);
    delivered.push({ agentGroupId, sessionId, text, sender });
    return Promise.resolve(true);
  },
  replyToCaller: vi.fn().mockResolvedValue(true),
}));

const { createTask, getTask, setDraftAnswer } = await import('../db/worker-tasks.js');
const { createGrant, findLiveGrantForTask } = await import('../db/worker-channel-grants.js');
const { finalizeWorkerTaskIfRunning } = await import('./finalize.js');
import type { WorkerTask } from '../types.js';

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
  routed.length = 0;
  projected.length = 0;
  failNextDelivery.value = false;
  sessionGone.value = false;
  registerWorkerMigration();
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

  // The container overwrites the draft after EVERY turn, so a run that died on
  // its first turn still holds text — usually something like "Looking into it".
  // Delivered bare, that reads as the finished answer.
  it('marks a draft from an interrupted run as incomplete', async () => {
    await createTask(aRunningTask());
    await setDraftAnswer('wt-1', 'Looking into it');

    expect(await finalizeWorkerTaskIfRunning('sess-helper', 'session-ended')).toBe(true);
    expect(delivered[0]!.text).toContain('did not complete');
    expect(delivered[0]!.text).toContain('Looking into it');
  });

  it('marks a draft from a completed run as the answer, with no such caveat', async () => {
    await createTask(aRunningTask());
    await setDraftAnswer('wt-1', 'opened PR #482');

    expect(await finalizeWorkerTaskIfRunning('sess-helper', 'done')).toBe(true);
    expect(delivered[0]!.text).toContain('opened PR #482');
    expect(delivered[0]!.text).not.toContain('did not complete');
  });

  // D9: the lent access ends with the task, leaving nothing behind. Routing is
  // part of that — a worker session is reused for a follow-up in the same
  // thread, so a container that is not respawned between tasks would keep
  // addressing a conversation it no longer holds.
  it('reverts the worker session routing when it releases a lent conversation', async () => {
    await createTask(aRunningTask());
    await createGrant({
      task_id: 'wt-1',
      helper_agent_group_id: 'ag-helper',
      helper_session_id: 'sess-helper',
      messaging_group_id: 'mg-lent',
      channel_type: 'slack',
      platform_id: 'slack:C123',
      root_message_id: 'wlend-1',
      thread_id: '1788.42',
      local_destination_name: 'conversation',
      granted_by_session_id: 'sess-principal',
      granted_at: new Date().toISOString(),
      released_at: null,
    });

    expect(await finalizeWorkerTaskIfRunning('sess-helper', 'done')).toBe(true);

    expect(await findLiveGrantForTask('wt-1')).toBeUndefined();
    expect(routed).toContainEqual({ group: 'ag-helper', session: 'sess-helper' });
  });

  // The central row is deleted, but the worker resolves names from its own
  // session's projected map. Left there, the lent name still resolves and the
  // worker is told its message was sent — for a message the host then refuses.
  it('re-projects the destination list when it releases a lent conversation', async () => {
    await createTask(aRunningTask());
    await createGrant({
      task_id: 'wt-1',
      helper_agent_group_id: 'ag-helper',
      helper_session_id: 'sess-helper',
      messaging_group_id: 'mg-lent',
      channel_type: 'slack',
      platform_id: 'slack:C123',
      root_message_id: 'wlend-1',
      thread_id: '1788.42',
      local_destination_name: 'conversation',
      granted_by_session_id: 'sess-principal',
      granted_at: new Date().toISOString(),
      released_at: null,
    });

    expect(await finalizeWorkerTaskIfRunning('sess-helper', 'done')).toBe(true);

    expect(projected).toContainEqual({ group: 'ag-helper', session: 'sess-helper' });
  });

  it('refreshes no routing when the task held no conversation', async () => {
    await createTask(aRunningTask());

    expect(await finalizeWorkerTaskIfRunning('sess-helper', 'done')).toBe(true);
    expect(routed).toHaveLength(0);
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

  // A transient failure earns a retry. A principal session that no longer
  // exists does not — handing the claim back there would leave the task
  // running for good, still holding its lent conversation, waiting for a
  // reader that will never come.
  it('finalizes rather than retrying when the principal session is gone', async () => {
    await createTask(aRunningTask());
    await createGrant({
      task_id: 'wt-1',
      helper_agent_group_id: 'ag-helper',
      helper_session_id: 'sess-helper',
      messaging_group_id: 'mg-lent',
      channel_type: 'slack',
      platform_id: 'slack:C123',
      root_message_id: 'wlend-1',
      thread_id: '1788.42',
      local_destination_name: 'conversation',
      granted_by_session_id: 'sess-principal',
      granted_at: new Date().toISOString(),
      released_at: null,
    });
    sessionGone.value = true;

    expect(await finalizeWorkerTaskIfRunning('sess-helper', 'done')).toBe(true);

    expect((await getTask('wt-1'))?.status).toBe('answered');
    expect(await findLiveGrantForTask('wt-1')).toBeUndefined();
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
    const { createQuestion, findOpenQuestion } = await import('../db/worker-questions.js');
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
