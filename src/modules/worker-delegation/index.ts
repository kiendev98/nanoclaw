/**
 * Worker delegation — an assistant hands work to a helper that stands inside
 * another repository, and gets exactly one report back.
 *
 * Seven delivery actions, two of them guarded. The two that write central-DB
 * state — creating a helper, lending a conversation — carry the guard. The
 * other five are scoped to the caller's own task row and carry an explicit
 * `unguarded()` reason instead, so the choice is visible in the diff that made
 * it.
 *
 * The folders follow the brief's own requirement groups, so a reader who knows
 * a letter knows where to look. The files here are the kernel every group uses:
 * this composition root, the row shapes, the id generator, both guarded
 * actions, and the two ways to write into a session.
 *
 *   delegate/  hand work to a worker inside another repository (A)
 *   report/    one report per task, drafts and progress notes (B)
 *   ask/       a worker asks its principal, and is answered (C)
 *   lend/      a worker holds one conversation with a counterparty (D)
 *   db/        every table this module owns
 *
 * One edge crosses a folder: report/finalize releases the lent conversation,
 * because a grant ends with the task that bounded it (D9).
 *
 * Host integration points, all table-guarded so core runs without this module:
 *   - `container-runner.ts::buildMounts` mounts the session's worktree.
 *   - `container-runner.ts::finish` fires the terminal hook this registers,
 *     which is what makes a crashed helper still report (B3).
 *   - `session-manager.ts::writeSessionRouting` projects a lent conversation.
 *   - `router.ts` routes a lent thread to its holder before the fan-out.
 */
import { registerExemptThreadQuery } from '../../channels/thread-exemptions.js';
import { registerSessionTerminalHook } from '../../container-runner.js';
import { registerWorkerMigration } from './db/migrate.js';
import { registerDeliveryAction, registerPostDeliveryHook, reenterGuardedDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { writeSessionRouting } from '../../session-manager.js';
import { unguarded } from '../../guard/index.js';
import { registerApprovalHandler } from '../approvals/index.js';
import { bindGrantThread } from './db/worker-channel-grants.js';
import { delegateTask, requestDelegateTaskHold, validateDelegateTask } from './delegate/delegate-task.js';
import { finalizeWorkerTaskIfRunning } from './report/finalize.js';
import {
  WORKER_DELEGATE_ACTION,
  WORKER_LEND_CONVERSATION_ACTION,
  workerDelegate,
  workerLendConversation,
} from './guard.js';
import { lendConversation, requestLendConversationHold, validateLendConversation } from './lend/lend-conversation.js';
import { isLentThread, rememberLentThread } from './lend/lent-threads.js';
import { replyToCaller } from './notify.js';
import { sendProgressNote } from './report/progress-notes.js';
import { askPrincipal, answerWorkerQuestion } from './ask/questions.js';
import { recordReportDraft, workerDone } from './report/report-draft.js';

registerWorkerMigration();

registerDeliveryAction(WORKER_DELEGATE_ACTION, delegateTask, {
  guardAction: workerDelegate,
  precheck: validateDelegateTask,
  requestHold: requestDelegateTaskHold,
  onDeny: async (_content, session, reason) => {
    await replyToCaller(session, `delegate_task denied: ${reason}`);
  },
});
registerApprovalHandler(WORKER_DELEGATE_ACTION, reenterGuardedDeliveryAction(WORKER_DELEGATE_ACTION));

registerDeliveryAction(WORKER_LEND_CONVERSATION_ACTION, lendConversation, {
  guardAction: workerLendConversation,
  precheck: validateLendConversation,
  requestHold: requestLendConversationHold,
  onDeny: async (_content, session, reason) => {
    await replyToCaller(session, `lend_conversation denied: ${reason}`);
  },
});
registerApprovalHandler(WORKER_LEND_CONVERSATION_ACTION, reenterGuardedDeliveryAction(WORKER_LEND_CONVERSATION_ACTION));

registerDeliveryAction(
  'worker_ask_principal',
  askPrincipal,
  unguarded('a helper asking its own principal about its own task — no central-DB privilege'),
);
registerDeliveryAction(
  'worker_answer_question',
  answerWorkerQuestion,
  unguarded('a principal answering a question addressed to it — verified against the question row'),
);
registerDeliveryAction(
  'worker_progress_note',
  sendProgressNote,
  unguarded("a rate-limited note scoped to the caller's own task row"),
);
registerDeliveryAction(
  'worker_report_draft',
  recordReportDraft,
  unguarded("an overwrite of the caller's own draft column, never delivered until finalize"),
);
registerDeliveryAction(
  'worker_done',
  workerDone,
  unguarded('the caller ending its own task — the terminal event does the same thing unprompted'),
);

/**
 * The backstop that makes B3 true.
 *
 * A helper that crashes never calls `done`, so the report cannot be the
 * helper's own action. The process ending is the signal, and it arrives whether
 * the run succeeded, failed, or was killed.
 */
registerSessionTerminalHook(async (sessionId, kind) => {
  // A restart exits the container without ending the run. Reporting here would
  // answer the principal while the worker is still on the task, and would tear
  // down a lent conversation the worker is about to return to.
  if (kind === 'restarting') return;
  await finalizeWorkerTaskIfRunning(sessionId, 'session-ended');
});

/** A thread a worker holds is a deliberate loop, not a runaway one. */
registerExemptThreadQuery(isLentThread);

/**
 * Bind a lent conversation to the thread its root post started.
 *
 * Only delivery knows the id the platform gave that post, and only after it
 * lands — so the grant is written unbound and stamped here.
 */
registerPostDeliveryHook(async (msg, _session, info) => {
  if (!info.platformMsgId) return;
  const grant = await bindGrantThread(msg.id, info.platformMsgId);
  if (!grant) return;
  // The grant was unbound when routing was last written, so the worker still
  // has no thread to continue. Re-project now that the platform has named it.
  await writeSessionRouting(grant.helper_agent_group_id, grant.helper_session_id);
  log.info('Lent conversation bound to its thread', { threadId: info.platformMsgId });
  // A review loop is bot-to-bot, and a channel's admission policy stops after
  // a few consecutive bot turns unless a human speaks. Claim this one thread,
  // so every other room keeps the cap.
  rememberLentThread(msg.channelType, msg.platformId, info.platformMsgId);
});
