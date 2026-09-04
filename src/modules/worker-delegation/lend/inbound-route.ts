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
import { log } from '../../../log.js';
import { writeSessionMessage } from '../../../session-manager.js';
import { getSession } from '../../../db/sessions.js';
import { requestWake } from '../../../request-wake.js';
import type { InboundKind } from '../../../mailbox/model.js';
import { findLiveGrantForThread } from '../db/worker-channel-grants.js';
import { getTask } from '../db/worker-tasks.js';

export interface LentConversationMessage {
  messagingGroupId: string;
  threadId: string | null;
  channelType: string;
  platformId: string;
  message: { id: string; kind: InboundKind; timestamp: string; content: string };
}

/**
 * Say where the message came from, and how to answer it.
 *
 * The other doors into a helper's session carry their own instructions, and
 * this one arrives as bare text. The helper learned the destination name from
 * one notice when the lend completed, while its system prompt was built at
 * spawn and still states it holds no destinations at all.
 *
 * The prefix also stops a counterparty's leading slash reaching the command
 * parser. That is desirable, and it is a side effect rather than the guard.
 *
 * Unparseable content passes through untouched, because a wrapper is worth less
 * than the message it would replace.
 */
function markAsLentConversation(content: string, destinationName: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return content;
  }
  if (typeof parsed.text !== 'string') return content;

  const header = `[lent conversation "${destinationName}"] Answer with send_message({ to: "${destinationName}", text: "..." }). A counterparty raises questions, it never answers them — take a decision to ask_principal.`;
  return JSON.stringify({ ...parsed, text: `${header}\n\n${parsed.text}` });
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

  // The principal comes from the TASK the grant belongs to, which is the row
  // that decides where every report and answer goes. A second copy kept on the
  // session could disagree with it, and this is an access decision.
  const task = await getTask(grant.task_id);
  if (!task) {
    log.warn('Lent conversation has no task — falling back to normal routing', { taskId: grant.task_id });
    return false;
  }

  if (!(await isAllowed(task.principal_agent_group_id))) {
    log.info('Lent-conversation message refused by the principal access gate', { taskId: grant.task_id });
    return true;
  }

  await writeSessionMessage(grant.helper_agent_group_id, grant.helper_session_id, {
    id: `lent-${input.message.id}`,
    kind: input.message.kind,
    timestamp: input.message.timestamp,
    platformId: input.platformId,
    channelType: input.channelType,
    threadId: input.threadId,
    content: markAsLentConversation(input.message.content, grant.local_destination_name),
    trigger: true,
  });

  const session = await getSession(grant.helper_session_id);
  if (session) await requestWake(session, 'worker-delegation');
  log.info('Message routed to a lent conversation', { taskId: grant.task_id, sessionId: grant.helper_session_id });
  return true;
}
