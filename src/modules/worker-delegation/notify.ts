/**
 * Writing into another session's inbound mailbox, and waking it.
 *
 * Every door this module opens between a helper and its principal ends here.
 * They differ only in the text they carry, which is what keeps each door to one
 * intent (B7) — there is no general-purpose send for a helper to reach for.
 */
import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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
  await writeSessionMessage(agentGroupId, sessionId, {
    id: generateId('worker'),
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: agentGroupId,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender, senderId: sender }),
  });
  const fresh = await getSession(sessionId);
  if (fresh) await requestWake(fresh, 'worker-delegation');
}

/** Answer the agent that made a request, in its own session. */
export async function notifyRequester(session: { agent_group_id: string; id: string }, text: string): Promise<void> {
  await deliverToSession(session.agent_group_id, session.id, text, 'system');
}
