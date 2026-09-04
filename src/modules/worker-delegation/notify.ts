/**
 * Writing into another session's inbound mailbox, and waking it.
 *
 * Every door this module opens between a helper and its principal ends here.
 * They differ only in the text they carry, which is what keeps each door to one
 * intent (B7) — there is no general-purpose send for a helper to reach for.
 */
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import { generateId } from './ids.js';

/**
 * Deliver one line of text into a session as an ordinary inbound message.
 *
 * Ordinary on purpose: a late answer still lands as something the agent reads
 * in its next turn, so a missed deadline destroys nothing (C8).
 */
export async function deliverToSession(
  agentGroupId: string,
  sessionId: string,
  text: string,
  sender: string,
): Promise<void> {
  // The session is read BEFORE the write. A scheduled-task session can be
  // deleted while the worker it started is still running, and writing to a
  // session that no longer exists creates a mailbox nothing ever polls — a
  // report that reads as delivered and is not.
  const target = await getSession(sessionId);
  if (!target) {
    log.error('Worker message undeliverable — the target session is gone', { agentGroupId, sessionId, sender });
    return;
  }

  await writeSessionMessage(agentGroupId, sessionId, {
    id: generateId('worker'),
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: agentGroupId,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender, senderId: sender }),
  });
  await requestWake(target, 'worker-delegation');
}

/** Answer the agent that made a request, in its own session. */
export async function replyToCaller(session: { agent_group_id: string; id: string }, text: string): Promise<void> {
  await deliverToSession(session.agent_group_id, session.id, text, 'system');
}
