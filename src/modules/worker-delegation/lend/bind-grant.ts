/**
 * Bind a lent conversation to the thread its root post started, then tell the
 * worker it holds one.
 *
 * Only delivery knows the id the platform gave that post, and only after it
 * lands — so the grant is written unbound and stamped here.
 */
import type { PostDeliveryInfo } from '../../../delivery.js';
import { log } from '../../../log.js';
import type { OutboundMessage } from '../../../mailbox/index.js';
import { writeSessionRouting } from '../../../session-manager.js';
import type { Session } from '../../../types.js';
import { bindGrantThread, findGrantByRootMessage } from '../db/worker-channel-grants.js';
import { consumeQuestion, findOpenQuestion } from '../db/worker-questions.js';
import { deliverToSession, replyToCaller } from '../notify.js';
import type { WorkerChannelGrant } from '../types.js';
import { rememberLentThread } from './lent-threads.js';

/**
 * The worker spawned with no destinations, so its system prompt states it
 * cannot send. That prompt is built once and never rebuilt, so this text has to
 * contradict it in as many words.
 *
 * A lend is not always an answer. Naming the closed question lets a worker that
 * was asking about something else ask it again.
 */
function lentConversationNotice(destinationName: string, closedQuestionId?: string): string {
  const notice = [
    'Your principal lent you one conversation for this task.',
    `Your destination list has changed since this session started, and you now hold "${destinationName}".`,
    `Post there with send_message({ to: "${destinationName}", text: "..." }).`,
  ];
  if (closedQuestionId) {
    notice.push(
      `This closed your open question ${closedQuestionId}, so ask again if you were asking about something else.`,
    );
  }
  return notice.join(' ');
}

/**
 * Close the question the lend answered, and name it only when this closed it.
 *
 * A worker asks for a conversation through ask_principal, and the principal
 * answers with the lend itself. The question stays open. C9 then refuses every
 * later ask for the rest of the task.
 *
 * Here, not at write time. A lend whose root post is never named grants
 * nothing, and consuming the question there strands the worker. Before the
 * delivery, not after. A notice that fails must still leave the worker free to
 * ask again.
 *
 * `answer_worker_question` can delete the same row between the read and the
 * delete. The notice then names a question that another action closed, which is
 * untrue, so the caller learns nothing about it.
 */
async function closeAnsweredQuestion(helperSessionId: string): Promise<string | undefined> {
  const open = await findOpenQuestion(helperSessionId);
  if (!open) return undefined;
  const consumed = await consumeQuestion(open.question_id);
  return consumed ? open.question_id : undefined;
}

/**
 * The extra fact the principal needs after a failed notice.
 *
 * The lend spent the worker's one open question, and the worker never heard the
 * notice that named it. Only the principal is left to know that.
 */
function closedQuestionNote(closedQuestionId: string | undefined): string {
  if (!closedQuestionId) return '';
  return ` The lend also closed its open question ${closedQuestionId}, and the worker was not told.`;
}

/**
 * Tell the worker it holds the conversation, and tell the principal when that
 * fails.
 *
 * The hook fires once and delivery swallows what it throws, so no retry
 * follows. A throw is transient and a dead session is permanent, so the two
 * messages stay different words.
 */
async function tellWorkerItHoldsTheConversation(
  grant: WorkerChannelGrant,
  session: Session,
  closedQuestionId: string | undefined,
): Promise<void> {
  const questionNote = closedQuestionNote(closedQuestionId);
  let told: boolean;
  try {
    told = await deliverToSession(
      grant.helper_agent_group_id,
      grant.helper_session_id,
      lentConversationNotice(grant.local_destination_name, closedQuestionId),
      'principal',
    );
  } catch (err) {
    // The conversation itself still works, because a counterparty reply routes
    // to the worker through the bound thread (D6).
    log.error('A lent conversation notice failed', {
      taskId: grant.task_id,
      helperSessionId: grant.helper_session_id,
      err,
    });
    await replyToCaller(
      session,
      `lend_conversation: the conversation is live, but the notice to the ${grant.helper_agent_group_id} worker did not go through, so it does not know it holds one. A reply in that thread still reaches it.${questionNote}`,
    );
    return;
  }

  if (!told) {
    log.error('A lent conversation reached no worker', {
      taskId: grant.task_id,
      helperSessionId: grant.helper_session_id,
    });
    await replyToCaller(
      session,
      `lend_conversation failed: the ${grant.helper_agent_group_id} worker session is gone, so it was never told about the conversation you lent it.${questionNote}`,
    );
  }
}

export async function bindLentConversationThread(
  msg: OutboundMessage,
  session: Session,
  info: PostDeliveryInfo,
): Promise<void> {
  if (!info.platformMsgId) {
    // A grant whose root post was never named keeps `thread_id = ''` for good,
    // so even a counterparty reply can never route to the worker. The principal
    // wrote that post from this session, and is the only party left to tell.
    const stranded = await findGrantByRootMessage(msg.id);
    if (!stranded) return;
    log.error('A lent conversation has no thread — the platform named no message', {
      taskId: stranded.task_id,
      rootMessageId: msg.id,
    });
    await replyToCaller(
      session,
      'lend_conversation failed: the platform never named the thread your opening message started, so the worker cannot reach that conversation.',
    );
    return;
  }

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

  const closedQuestionId = await closeAnsweredQuestion(grant.helper_session_id);

  // Last, and only last. The three steps above are what make the conversation
  // real: the destination is projected, routing carries the bound thread, and
  // the admission exemption is armed. A worker woken any earlier posts outside
  // the one thread it was lent.
  await tellWorkerItHoldsTheConversation(grant, session, closedQuestionId);
}
