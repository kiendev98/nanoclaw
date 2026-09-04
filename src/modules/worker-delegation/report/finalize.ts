/**
 * One answer per task, delivered by the host (B1).
 *
 * Reporting is never the helper's own action. A helper that crashes cannot
 * choose to speak, so the host reads back whatever draft the run left and
 * delivers it — which is the only way B3 can be true. The `done` tool is the
 * fast path to the same call, not a second mechanism: both go through the
 * status transition in `claimTaskForFinalize`, and exactly one wins.
 */
import { log } from '../../../log.js';
import { writeSessionRouting } from '../../../session-manager.js';
import { deleteDestination } from '../../agent-to-agent/db/agent-destinations.js';
import { releaseGrant } from '../db/worker-channel-grants.js';
import { deleteQuestionsForTask } from '../db/worker-questions.js';
import { claimTaskForFinalize, findRunningTask, releaseTaskClaim } from '../db/worker-tasks.js';
import { forgetLentThread } from '../lend/lent-threads.js';
import { deliverToSession } from '../notify.js';
import type { WorkerTask } from '../types.js';

/** Why the task ended. Only the wording differs; the delivery does not. */
export type FinalizeReason = 'done' | 'session-ended';

/**
 * The draft is the worker's last statement, not necessarily its answer.
 *
 * The container overwrites the draft after every turn, so a run that ended on
 * its own terms and a run that died mid-task both arrive holding text. Only
 * `done` means the worker chose to stop. Anything else must say so, or an
 * interrupted "Looking into it" reads as the finished result.
 */
function reportText(task: WorkerTask, reason: FinalizeReason): string {
  const header = `Report from the ${task.repo_name} worker (task ${task.task_id}):`;
  if (reason === 'done') {
    if (task.draft_answer) return `${header}\n\n${task.draft_answer}`;
    return `${header}\n\nThe worker did not complete. It reported itself done without leaving a statement.`;
  }
  if (task.draft_answer) {
    return `${header}\n\nThe worker did not complete — its run ended before it reported a result. Its last statement was:\n\n${task.draft_answer}`;
  }
  return `${header}\n\nThe worker did not complete. Its run ended before it stated a result.`;
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

  // The claim has to come first — it is what stops two callers reporting the
  // same task twice. So a delivery that fails after it would turn "exactly
  // one report" into none. Hand the claim back instead, and let the terminal
  // event try again.
  try {
    await deliverToSession(
      claimed.principal_agent_group_id,
      claimed.principal_session_id,
      reportText(claimed, reason),
      `${claimed.repo_name}-worker`,
    );
  } catch (err) {
    const handedBack = await releaseTaskClaim(claimed.task_id);
    log.error('Worker report undelivered', { taskId: claimed.task_id, reason, willRetry: handedBack, err });
    if (handedBack) return false;
    throw err;
  }

  // Only now: the lent conversation and the open question outlive a failed
  // delivery on purpose, so a retry still has them.
  await releaseLentConversation(claimed);
  await deleteQuestionsForTask(claimed.task_id);

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
  if (grant.thread_id) forgetLentThread(grant.channel_type, grant.platform_id, grant.thread_id);
  try {
    await deleteDestination(grant.helper_agent_group_id, grant.local_destination_name);
  } catch (err) {
    log.warn('Could not remove a lent destination', { taskId: task.task_id, err });
  }

  // The grant and the destination are gone, so re-projecting now writes the
  // routing without them. A worker session is reused for a follow-up task in
  // the same thread, so without this the reused container keeps addressing a
  // conversation it no longer holds.
  try {
    await writeSessionRouting(grant.helper_agent_group_id, grant.helper_session_id);
  } catch (err) {
    log.warn('Could not refresh routing after releasing a lent conversation', { taskId: task.task_id, err });
  }
}
