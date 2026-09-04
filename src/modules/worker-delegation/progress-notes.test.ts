/**
 * The progress-note budget is structural because guidance is not enough.
 *
 * Both bounds live in one conditional UPDATE, so two notes written in the same
 * instant cannot both pass a check that the other's write invalidates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { Session } from '../../types.js';

const { delivered, refusals } = vi.hoisted(() => ({
  delivered: [] as string[],
  refusals: [] as string[],
}));

vi.mock('./notify.js', () => ({
  deliverToSession: (_agentGroupId: string, _sessionId: string, text: string) => {
    delivered.push(text);
    return Promise.resolve();
  },
  replyToCaller: (_session: Session, text: string) => {
    refusals.push(text);
    return Promise.resolve();
  },
}));

const { MAX_PROGRESS_NOTES, MIN_PROGRESS_NOTE_GAP_MS, createTask, spendProgressNoteAllowance } =
  await import('./db/worker-tasks.js');
const { sendProgressNote } = await import('./progress-notes.js');
import type { WorkerTask } from './types.js';

const HELPER_SESSION = { id: 'sess-helper', agent_group_id: 'ag-helper' } as Session;

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

/** Far enough apart that only the count can refuse. */
function spacedOut(index: number): Date {
  return new Date(Date.now() + index * MIN_PROGRESS_NOTE_GAP_MS * 2);
}

beforeEach(async () => {
  delivered.length = 0;
  refusals.length = 0;
  await runMigrations(await initTestDb());
  await createTask(task);
});

afterEach(async () => {
  await closeDb();
});

describe('sendProgressNote', () => {
  it('marks the note as progress and says it is not the report (B5)', async () => {
    await sendProgressNote({ text: 'tests pass' }, HELPER_SESSION);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('[progress]');
    expect(delivered[0]).toContain('do not relay');
    expect(delivered[0]).toContain('tests pass');
  });

  it('drops a second note inside the gap rather than queueing it', async () => {
    await sendProgressNote({ text: 'one' }, HELPER_SESSION);
    await sendProgressNote({ text: 'two' }, HELPER_SESSION);

    expect(delivered).toHaveLength(1);
    expect(refusals.at(-1)).toContain('dropped');
  });

  it('refuses when the session has no running task', async () => {
    await sendProgressNote({ text: 'one' }, { id: 'sess-other', agent_group_id: 'ag-x' } as Session);
    expect(delivered).toHaveLength(0);
    expect(refusals.at(-1)).toContain('no running task');
  });
});

describe('spendProgressNoteAllowance', () => {
  it('spends the whole budget and then refuses, however patient the caller is', async () => {
    for (let index = 0; index < MAX_PROGRESS_NOTES; index++) {
      expect(await spendProgressNoteAllowance('wt-1', spacedOut(index))).toBe(true);
    }
    expect(await spendProgressNoteAllowance('wt-1', spacedOut(MAX_PROGRESS_NOTES))).toBe(false);
  });

  it('refuses a note that arrives inside the gap', async () => {
    const now = new Date();
    expect(await spendProgressNoteAllowance('wt-1', now)).toBe(true);
    expect(await spendProgressNoteAllowance('wt-1', new Date(now.getTime() + 1))).toBe(false);
  });

  it('refuses once the task is no longer running', async () => {
    const { claimTaskForFinalize } = await import('./db/worker-tasks.js');
    await claimTaskForFinalize('wt-1', new Date().toISOString());
    expect(await spendProgressNoteAllowance('wt-1', new Date())).toBe(false);
  });
});
