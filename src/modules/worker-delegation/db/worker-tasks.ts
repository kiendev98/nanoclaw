/** `worker_tasks` — one delegated task, its draft answer, and its progress-note budget. */
import { getDb } from '../../../db/connection.js';
import type { WorkerTask } from '../types.js';

/** At most this many progress notes reach the principal per task (Q8). */
export const MAX_PROGRESS_NOTES = 5;
/** And no faster than this, so a helper cannot narrate its way through the budget. */
export const MIN_PROGRESS_NOTE_GAP_MS = 10_000;

export async function getTask(taskId: string): Promise<WorkerTask | undefined> {
  return getDb().get<WorkerTask>('SELECT * FROM worker_tasks WHERE task_id = ?', taskId);
}

/** The task a helper session is working now, if any. */
export async function findRunningTask(helperSessionId: string): Promise<WorkerTask | undefined> {
  return getDb().get<WorkerTask>(
    "SELECT * FROM worker_tasks WHERE helper_session_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1",
    helperSessionId,
  );
}

export async function createTask(task: WorkerTask): Promise<void> {
  await getDb().run(
    `INSERT INTO worker_tasks (
        task_id, helper_session_id, helper_agent_group_id, repo_name,
        principal_agent_group_id, principal_session_id, description, status,
        draft_answer, progress_note_count, last_progress_note_at, created_at, completed_at
      ) VALUES (
        @task_id, @helper_session_id, @helper_agent_group_id, @repo_name,
        @principal_agent_group_id, @principal_session_id, @description, @status,
        @draft_answer, @progress_note_count, @last_progress_note_at, @created_at, @completed_at
      )`,
    { ...task },
  );
}

/**
 * Overwrite the draft. Never append — only the last statement is the answer
 * (B2), and finalize reads whatever this left behind.
 */
export async function setDraftAnswer(taskId: string, draft: string): Promise<void> {
  await getDb().run("UPDATE worker_tasks SET draft_answer = ? WHERE task_id = ? AND status = 'running'", draft, taskId);
}

/**
 * The once-only fence behind B1: exactly one caller sees `true`.
 *
 * The status transition is the fence, and it is a conditional UPDATE rather
 * than a read-then-write, so a `done` tool racing the terminal event still
 * delivers one report.
 */
export async function claimTaskForFinalize(taskId: string, completedAt: string): Promise<WorkerTask | undefined> {
  const result = await getDb().run(
    "UPDATE worker_tasks SET status = 'answered', completed_at = ? WHERE task_id = ? AND status = 'running'",
    completedAt,
    taskId,
  );
  if (result.changes === 0) return undefined;
  return getTask(taskId);
}

/**
 * Spend one progress-note allowance, or refuse.
 *
 * Both bounds are enforced in the UPDATE's WHERE clause, so two notes written
 * in the same instant cannot both pass a check that a later write invalidates.
 */
export async function spendProgressNoteAllowance(taskId: string, now: Date): Promise<boolean> {
  const nowIso = now.toISOString();
  const earliestPrevious = new Date(now.getTime() - MIN_PROGRESS_NOTE_GAP_MS).toISOString();
  const result = await getDb().run(
    `UPDATE worker_tasks
        SET progress_note_count = progress_note_count + 1, last_progress_note_at = ?
      WHERE task_id = ?
        AND status = 'running'
        AND progress_note_count < ?
        AND (last_progress_note_at IS NULL OR last_progress_note_at <= ?)`,
    nowIso,
    taskId,
    MAX_PROGRESS_NOTES,
    earliestPrevious,
  );
  return result.changes > 0;
}
