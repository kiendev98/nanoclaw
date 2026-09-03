/**
 * The two things every blocking container tool needs from its host half.
 *
 * `spawn_worker` and `answer_worker` are the same shape: the container writes
 * a system action carrying a `requestId` and a `waitUntil`, then polls its own
 * inbound for a row naming that id. Both therefore face the same race — the
 * host may finish after the tool has given up — and both answer it the same
 * way, so the answer lives here once rather than in each handler.
 *
 * The third piece is the ENVELOPE around the response row, and only the
 * envelope. `kind: 'system'`, `trigger: false`, the null address, the
 * timestamp, and the `{ type, requestId, status, result }` frame are the same
 * for every blocking action, and a change to any of them — a field the poll
 * loop starts relying on, a kind it stops filtering — has to land on all of
 * them at once or one tool silently stops being answered.
 *
 * What stays with each action is what genuinely differs: its `type` string and
 * the shape of its `result`. Those ARE that action's contract with its tool,
 * and pushing them in here would have made this a switch over callers.
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

/**
 * Answer a blocking tool, and wake the requester when it has already given up.
 *
 * The row is `kind: 'system'` and non-triggering: the tool polls for it by
 * `requestId`, and the poll loop filters system rows out of agent prompts, so
 * it can never read as an unanswered wake.
 *
 * @param response `id` is the row id the action chose (prefixed per action, so
 *   two tools answering the same requestId cannot collide); `type` and
 *   `result` are the action's own contract with its tool.
 * @param lateMessage Prose for the requester when the tool has stopped
 *   listening — the row alone would reach nobody.
 */
export async function respondToBlockingTool(
  session: Session,
  req: { requestId: string; waitUntil: number | null },
  response: { id: string; type: string; status: string; result: Record<string, unknown> },
  lateMessage: string,
): Promise<void> {
  if (req.requestId) {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: response.id,
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({
        type: response.type,
        requestId: req.requestId,
        status: response.status,
        result: response.result,
      }),
      trigger: false,
    });
  }
  if (callerStoppedWaiting(req.waitUntil)) await notifyAgent(session, lateMessage);
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
