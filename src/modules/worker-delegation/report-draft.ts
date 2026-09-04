/**
 * The draft answer, and the helper's own way to say it has finished.
 *
 * `worker_report_draft` mirrors `task_log`'s shape — the runner writes the
 * turn's final text automatically — but it OVERWRITES rather than appends.
 * Only the last statement is the answer (B2), and nothing here is ever
 * delivered: finalize reads the column once.
 */
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { findRunningTask, setDraftAnswer } from './db/worker-tasks.js';
import { finalizeWorkerTaskIfRunning } from './finalize.js';
import { notifyRequester } from './notify.js';

function readText(content: Record<string, unknown>): string {
  return typeof content.text === 'string' ? content.text.trim() : '';
}

/** Automatic, once per turn. A helper never has to remember to do this. */
export async function recordReportDraft(content: Record<string, unknown>, session: Session): Promise<void> {
  const text = readText(content);
  if (!text) return;
  const task = await findRunningTask(session.id);
  if (!task) return;
  await setDraftAnswer(task.task_id, text);
}

/**
 * `worker_done` — the fast path to the one report.
 *
 * The terminal event would deliver the same report when the run ends. This
 * exists so a helper that finishes early does not hold the principal waiting
 * for its process to exit, and the status transition means only one of the two
 * ever delivers.
 */
export async function workerDone(content: Record<string, unknown>, session: Session): Promise<void> {
  const text = readText(content);
  const task = await findRunningTask(session.id);
  if (!task) {
    await notifyRequester(session, 'done: there is no running task on this session.');
    return;
  }
  if (text) await setDraftAnswer(task.task_id, text);
  const delivered = await finalizeWorkerTaskIfRunning(session.id, 'done');
  if (!delivered) log.info('worker done raced the terminal event', { taskId: task.task_id });
}
