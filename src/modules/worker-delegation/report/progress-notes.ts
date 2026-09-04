/**
 * An early note that is not the answer (B4, B5).
 *
 * Marked as progress in the text the principal reads, so relaying it would be a
 * visible mistake rather than an invisible one. The budget is structural
 * because guidance alone does not stop a model narrating: five per task, ten
 * seconds apart, and a note past either bound is dropped and logged rather than
 * queued (Q8).
 */
import { log } from '../../../log.js';
import type { Session } from '../../../types.js';
import { MAX_PROGRESS_NOTES, findRunningTask, spendProgressNoteAllowance } from '../db/worker-tasks.js';
import { deliverToSession, replyToCaller } from '../notify.js';

export async function sendProgressNote(content: Record<string, unknown>, session: Session): Promise<void> {
  const text = typeof content.text === 'string' ? content.text.trim() : '';
  if (!text) return;

  const task = await findRunningTask(session.id);
  if (!task) {
    await replyToCaller(session, 'send_progress_note failed: there is no running task on this session.');
    return;
  }

  if (!(await spendProgressNoteAllowance(task.task_id, new Date()))) {
    log.info('Worker progress note dropped', { taskId: task.task_id, cap: MAX_PROGRESS_NOTES });
    await replyToCaller(
      session,
      `send_progress_note: dropped. A task carries at most ${MAX_PROGRESS_NOTES} notes, ten seconds apart. Save it for your report.`,
    );
    return;
  }

  const delivered = await deliverToSession(
    task.principal_agent_group_id,
    task.principal_session_id,
    [
      `[progress] The ${task.repo_name} worker on task ${task.task_id}. This is NOT the report — do not relay it.`,
      '',
      text,
    ].join('\n'),
    `${task.repo_name}-worker`,
  );

  // The allowance is already spent, and a note is not worth re-spending it on.
  // But the worker must not read silence as delivery: its principal is gone,
  // which is the same thing its report will hit at the end of the task.
  if (!delivered) {
    log.error('Worker progress note undeliverable', {
      taskId: task.task_id,
      principalSessionId: task.principal_session_id,
    });
    await replyToCaller(
      session,
      'send_progress_note: your principal is no longer reachable, so the note went nowhere.',
    );
  }
}
