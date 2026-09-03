/**
 * The answer half of a blocking container tool.
 *
 * A container tool that waits on the host writes a request row carrying a
 * `requestId` and a `waitUntil` deadline, then polls for a response row keyed
 * by that id. The host action finishes whenever it finishes — which may be
 * after the tool gave up — so every outcome has to reach the caller by
 * whichever of the two doors is still open.
 *
 * Those two fields are independent, and that is what gives three delivery
 * modes rather than two:
 *
 * | `requestId` | `waitUntil` | The caller asked for                     |
 * |-------------|-------------|------------------------------------------|
 * | set         | a deadline  | the answer inline, and a wake if it is late |
 * | set         | `null`      | the answer whenever it is ready, by wake  |
 * | absent      | —           | nothing. Fire and forget                  |
 *
 * The third row is why the wake lives INSIDE the `requestId` check — for a
 * SUCCESS. A caller that minted no correlation id is not polling and did not
 * ask to be told it merely started, so waking it would start a container to
 * deliver a result nobody wanted.
 *
 * A FAILURE is exempt from that row. Fire-and-forget means "don't bother me
 * with how it went", not "don't bother me if it failed outright" — the caller
 * may already have been told elsewhere that the work is under way (e.g.
 * `run_task`'s tool response, "Queued in <repo>…"), and an error that reaches
 * nobody is worse than an unwanted wake. A caller in that position calls the
 * exported `wakeRequester` directly on its own failure path instead of going
 * through `respondAndWake`, which stays a no-op with no `requestId` regardless
 * of outcome.
 */
import { getSession } from './db/sessions.js';
import { requestWake } from './request-wake.js';
import { writeSessionMessage } from './session-manager.js';
import type { Session } from './types.js';

/**
 * Grace on `waitUntil`. Inside the window the tool is still polling and the
 * response row alone reaches it; within this margin of the deadline the race
 * is unwinnable either way, so the requester is woken too. A duplicate wake
 * costs one turn; the other error costs the whole request, silently.
 */
export const LATE_MARGIN_MS = 5_000;

/** The correlation fields every blocking tool's payload carries. */
export interface BoundedRequest {
  /** What the polling tool matches on. Empty means nobody is listening. */
  requestId: string;
  /** Epoch ms at which the caller's poll expires, or null if it never polled. */
  waitUntil: number | null;
}

/** What one finished host action has to say for itself. */
export interface BoundedResponse {
  /** Row-id prefix, unique per action — `run-task` gives `run-task-resp-<id>`. */
  kind: string;
  /** The typed body the container tool parses out of the response row. */
  body: Record<string, unknown>;
  /** Chat text, used only on the wake path. Never shown to a polling caller. */
  wakeText: string;
}

/** Read the correlation fields out of a container payload. */
export function parseBoundedRequest(content: Record<string, unknown>): BoundedRequest {
  return {
    requestId: typeof content.requestId === 'string' ? content.requestId.trim() : '',
    waitUntil: typeof content.waitUntil === 'number' ? content.waitUntil : null,
  };
}

/** Is the tool that asked still listening, or has its bounded wait run out? */
export function callerStoppedWaiting(req: BoundedRequest): boolean {
  // An absent deadline means the caller never polled — it asked to be woken
  // instead. Same answer as an expired one: write the row, then wake.
  if (req.waitUntil === null) return true;
  return Date.now() > req.waitUntil - LATE_MARGIN_MS;
}

/**
 * Answer the blocking tool, and wake the requester when the tool has already
 * given up.
 *
 * The response row is `kind: 'system'` and non-triggering, exactly like
 * `canvas_read`'s: the tool polls for it by `requestId`, and the poll loop
 * filters system rows out of agent prompts, so it can never read as an
 * unanswered wake.
 *
 * Does nothing at all when `requestId` is empty — see the table above.
 */
export async function respondAndWake(session: Session, req: BoundedRequest, response: BoundedResponse): Promise<void> {
  if (!req.requestId) return;

  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `${response.kind}-resp-${req.requestId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ ...response.body, requestId: req.requestId }),
    trigger: false,
  });

  if (callerStoppedWaiting(req)) await wakeRequester(session, response.wakeText);
}

/**
 * A renderable chat note that wakes the requester — the late-answer path.
 *
 * Exported for callers that must reach the requester even with no
 * `requestId` at all, which `respondAndWake` never does (see the table
 * above) — a failure a caller answers through `run_task`'s `respond()` being
 * the motivating case.
 */
export async function wakeRequester(session: Session, text: string): Promise<void> {
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
