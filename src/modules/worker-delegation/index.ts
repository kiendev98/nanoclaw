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
 * Host integration points, all table-guarded so core runs without this module:
 *   - `container-runner.ts::buildMounts` mounts the session's worktree.
 *   - `container-runner.ts::finish` fires the terminal hook this registers,
 *     which is what makes a crashed helper still report (B3).
 *   - `session-manager.ts::writeSessionRouting` projects a lent conversation.
 *   - `router.ts` routes a lent thread to its holder before the fan-out.
 */
import { exemptThreadFromHopLimit } from '../../channels/slack-a2a.js';
import { registerSessionTerminalHook } from '../../container-runner.js';
import { registerDeliveryAction, registerPostDeliveryHook, reenterGuardedDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { unguarded } from '../../guard/index.js';
import { registerApprovalHandler } from '../approvals/index.js';
import { bindGrantThread } from './db/worker-channel-grants.js';
import { delegateTask, requestDelegateTaskHold, validateDelegateTask } from './delegate-task.js';
import { finalizeWorkerTaskIfRunning } from './finalize.js';
import {
  WORKER_DELEGATE_ACTION,
  WORKER_LEND_CONVERSATION_ACTION,
  workerDelegate,
  workerLendConversation,
} from './guard.js';
import { lendConversation, requestLendConversationHold, validateLendConversation } from './lend-conversation.js';
import { notifyRequester } from './notify.js';
import { sendProgressNote } from './progress-notes.js';
import { askPrincipal, answerWorkerQuestion } from './questions.js';
import { recordReportDraft, workerDone } from './report-draft.js';

registerDeliveryAction(WORKER_DELEGATE_ACTION, delegateTask, {
  guardAction: workerDelegate,
  precheck: validateDelegateTask,
  requestHold: requestDelegateTaskHold,
  onDeny: (_content, session, reason) => notifyRequester(session, `delegate_task denied: ${reason}`),
});
registerApprovalHandler(WORKER_DELEGATE_ACTION, reenterGuardedDeliveryAction(WORKER_DELEGATE_ACTION));

registerDeliveryAction(WORKER_LEND_CONVERSATION_ACTION, lendConversation, {
  guardAction: workerLendConversation,
  precheck: validateLendConversation,
  requestHold: requestLendConversationHold,
  onDeny: (_content, session, reason) => notifyRequester(session, `lend_conversation denied: ${reason}`),
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
registerSessionTerminalHook(async (sessionId) => {
  await finalizeWorkerTaskIfRunning(sessionId, 'session-ended');
});

/**
 * Bind a lent conversation to the thread its root post started.
 *
 * Only delivery knows the id the platform gave that post, and only after it
 * lands — so the grant is written unbound and stamped here.
 */
registerPostDeliveryHook(async (msg, _session, info) => {
  if (!info.platformMsgId) return;
  if (!(await bindGrantThread(msg.id, info.platformMsgId))) return;
  log.info('Lent conversation bound to its thread', { threadId: info.platformMsgId });
  // A review loop is bot-to-bot, and Slack's admission policy stops after six
  // consecutive bot turns unless a human speaks. Exempt this one thread rather
  // than raising the cap for every room.
  if (msg.channelType === 'slack' && msg.platformId) {
    exemptThreadFromHopLimit(msg.platformId, info.platformMsgId);
  }
});
