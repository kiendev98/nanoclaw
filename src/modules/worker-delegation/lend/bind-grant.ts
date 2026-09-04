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
import { deliverToSession, replyToCaller } from '../notify.js';
import { rememberLentThread } from './lent-threads.js';

/**
 * The worker spawned with no destinations, so its system prompt states it
 * cannot send. That prompt is built once and never rebuilt, so this text has to
 * contradict it in as many words.
 */
function lentConversationNotice(destinationName: string): string {
  return [
    'Your principal lent you one conversation for this task.',
    `Your destination list has changed since this session started, and you now hold "${destinationName}".`,
    `Post there with send_message({ to: "${destinationName}", text: "..." }).`,
  ].join(' ');
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

  // Last, and only last. The three steps above are what make the conversation
  // real: the destination is projected, routing carries the bound thread, and
  // the admission exemption is armed. A worker woken any earlier posts outside
  // the one thread it was lent.
  const told = await deliverToSession(
    grant.helper_agent_group_id,
    grant.helper_session_id,
    lentConversationNotice(grant.local_destination_name),
    'principal',
  );
  if (!told) {
    log.error('A lent conversation reached no worker', {
      taskId: grant.task_id,
      helperSessionId: grant.helper_session_id,
    });
    await replyToCaller(
      session,
      `lend_conversation failed: the ${grant.helper_agent_group_id} worker session is gone, so it was never told about the conversation you lent it.`,
    );
  }
}
