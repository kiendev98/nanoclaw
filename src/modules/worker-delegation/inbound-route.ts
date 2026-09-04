/**
 * A thread a helper holds belongs to that helper (D5, D6, D8).
 *
 * Every message in it reaches the helper without anyone naming it, because the
 * helper opened the conversation for exactly this. Nothing else engages, so a
 * second agent cannot answer a request it was never briefed on.
 *
 * D7 needs no branch of its own. Naming the assistant inside the thread runs
 * that turn in the SAME session, so being named still gets a reply, and there
 * is never a double one.
 */
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { findLiveGrantForThread } from './db/worker-channel-grants.js';

export interface LentConversationMessage {
  messagingGroupId: string;
  threadId: string | null;
  channelType: string;
  platformId: string;
  message: { id: string; kind: string; timestamp: string; content: string };
}

/**
 * Deliver an inbound message to the helper that holds its thread.
 *
 * Returns false when no helper holds it, which is every ordinary message —
 * the caller then runs its normal fan-out.
 *
 * `isAllowed` is the caller's own access gate, applied to the PRINCIPAL's agent
 * group: a helper admits exactly who its principal admits, and it keeps
 * admitting them live rather than from a snapshot taken when it was created
 * (D10).
 */
export async function deliverToLentConversation(
  input: LentConversationMessage,
  isAllowed: (principalAgentGroupId: string) => Promise<boolean>,
): Promise<boolean> {
  if (!input.threadId) return false;
  const grant = await findLiveGrantForThread(input.messagingGroupId, input.threadId);
  if (!grant) return false;

  const { getWorkerSession } = await import('./db/worker-sessions.js');
  const workerSession = await getWorkerSession(grant.helper_session_id);
  if (!workerSession) {
    log.warn('Lent conversation has no worker session — falling back to normal routing', { taskId: grant.task_id });
    return false;
  }

  if (!(await isAllowed(workerSession.principal_agent_group_id))) {
    log.info('Lent-conversation message refused by the principal access gate', { taskId: grant.task_id });
    return true;
  }

  await writeSessionMessage(grant.helper_agent_group_id, grant.helper_session_id, {
    id: `lent-${input.message.id}`,
    kind: input.message.kind as Parameters<typeof writeSessionMessage>[2]['kind'],
    timestamp: input.message.timestamp,
    platformId: input.platformId,
    channelType: input.channelType,
    threadId: input.threadId,
    content: input.message.content,
    trigger: true,
  });

  const session = await getSession(grant.helper_session_id);
  if (session) await requestWake(session, 'worker-delegation');
  log.info('Message routed to a lent conversation', { taskId: grant.task_id, sessionId: grant.helper_session_id });
  return true;
}
