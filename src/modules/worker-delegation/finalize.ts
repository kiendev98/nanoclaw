/**
 * One answer per task, delivered by the host (B1).
 *
 * Reporting is never the helper's own action. A helper that crashes cannot
 * choose to speak, so the host reads back whatever draft the run left and
 * delivers it — which is the only way B3 can be true. The `done` tool is the
 * fast path to the same call, not a second mechanism: both go through the
 * status transition in `claimTaskForFinalize`, and exactly one wins.
 */
import { restoreHopLimitOnThread } from '../../channels/slack-a2a.js';
import { log } from '../../log.js';
import { deleteDestination } from '../agent-to-agent/db/agent-destinations.js';
import { releaseGrant } from './db/worker-channel-grants.js';
import { deleteQuestionsForTask } from './db/worker-questions.js';
import { claimTaskForFinalize, findRunningTask } from './db/worker-tasks.js';
import { deliverToSession } from './notify.js';
import type { WorkerTask } from './types.js';

/** Why the task ended. Only the wording differs; the delivery does not. */
export type FinalizeReason = 'done' | 'session-ended';

function reportText(task: WorkerTask, reason: FinalizeReason): string {
  const header = `Report from the ${task.repo_name} worker (task ${task.task_id}):`;
  if (task.draft_answer) return `${header}\n\n${task.draft_answer}`;
  const cause =
    reason === 'done'
      ? 'It reported itself done without leaving a statement.'
      : 'Its run ended before it stated a result.';
  return `${header}\n\nThe worker did not complete. ${cause}`;
}

/**
 * Finalize the running task on a helper session, if there is one.
 *
 * Safe to call on any session: a session with no running task is a no-op, which
 * is what lets the terminal-event backstop fire unconditionally.
 */
export async function finalizeWorkerTaskIfRunning(helperSessionId: string, reason: FinalizeReason): Promise<boolean> {
  const running = await findRunningTask(helperSessionId);
  if (!running) return false;

  const claimed = await claimTaskForFinalize(running.task_id, new Date().toISOString());
  if (!claimed) return false;

  await releaseLentConversation(claimed);
  await deleteQuestionsForTask(claimed.task_id);

  await deliverToSession(
    claimed.principal_agent_group_id,
    claimed.principal_session_id,
    reportText(claimed, reason),
    `${claimed.repo_name}-worker`,
  );
  log.info('Worker task finalized', { taskId: claimed.task_id, reason, hasDraft: Boolean(claimed.draft_answer) });
  return true;
}

/**
 * The lent access ends with the task, leaving nothing for an operator to
 * remove (D9) — the grant row and the destination row that realizes it.
 */
async function releaseLentConversation(task: WorkerTask): Promise<void> {
  const grant = await releaseGrant(task.task_id, new Date().toISOString());
  if (!grant) return;
  if (grant.channel_type === 'slack' && grant.thread_id) {
    restoreHopLimitOnThread(grant.platform_id, grant.thread_id);
  }
  try {
    await deleteDestination(grant.helper_agent_group_id, grant.local_destination_name);
  } catch (err) {
    log.warn('Could not remove a lent destination', { taskId: task.task_id, err });
  }
}
