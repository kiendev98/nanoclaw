/**
 * The two things every blocking container tool needs from its host half.
 *
 * `spawn_worker` and `answer_worker` are the same shape: the container writes
 * a system action carrying a `requestId` and a `waitUntil`, then polls its own
 * inbound for a row naming that id. Both therefore face the same race — the
 * host may finish after the tool has given up — and both answer it the same
 * way, so the answer lives here once rather than in each handler.
 *
 * There is no third piece. Writing the response row stays with each action,
 * because its `type` and its `result` shape are that action's own contract
 * with its tool.
 */
import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

/**
 * Grace on `waitUntil`. Inside the window the tool is still polling and the
 * response row alone reaches it; within this margin of the deadline the race
 * is unwinnable either way, so the requester is woken too. A duplicate wake
 * costs one turn; the other error costs the whole request, silently.
 */
const LATE_MARGIN_MS = 5_000;

/**
 * Is the tool that asked still listening, or has its bounded wait run out?
 *
 * @param waitUntil The tool's own deadline, as it stamped it.
 */
export function callerStoppedWaiting(waitUntil: number | null): boolean {
  // An absent deadline means the payload did not come from the tool (a
  // hand-written row, an older container). Treat it as no longer waiting:
  // an extra wake is recoverable, a lost answer is not.
  if (waitUntil === null) return true;
  return Date.now() > waitUntil - LATE_MARGIN_MS;
}

/** A renderable chat note that wakes the requester — the late-answer path. */
export async function notifyAgent(session: Session, text: string): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = await getSession(session.id);
  if (fresh) await requestWake(fresh, 'agent-created');
}
