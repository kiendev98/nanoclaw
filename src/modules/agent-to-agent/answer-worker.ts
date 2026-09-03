/**
 * `answer_worker` delivery-action body — the host half of the container's
 * blocking `answer_worker` tool (container/agent-runner/src/mcp-tools/workers.ts).
 *
 * IT EXISTS BECAUSE NO OTHER DOOR CARRIES INTENT. `send_message` and
 * `spawn_worker`'s reuse path both end in `routeAgentMessage`, producing a
 * byte-identical `kind: 'chat'` row — so a worker blocked inside
 * `ask_user_question` could not tell an answer from a second instruction. It
 * used to guess: first message carrying text, after the question went out.
 * That made ORDER load-bearing, and an orchestrator that sent "also bump the
 * dep" during the same turn had it silently relabelled as the decision.
 *
 * `in_reply_to` cannot fix that, which is why this is a tool and not a field.
 * `messages_in` has no such column, `performAgentRoute` mints a fresh id
 * rather than carrying the question's, and the stamp is batch-scoped — the
 * poll loop sets it once per batch, so a second unrelated message in the same
 * turn carries the same value. The exact case needing separation stays
 * indistinguishable.
 *
 * A FLAG ON `send_message` WAS REJECTED for the same reason the verb is
 * separate: `send_message` is already polymorphic over destination type, and a
 * flag would make one verb span posting to a channel, giving a worker work,
 * and unblocking a waiting call. In a transcript those three read identically.
 *
 * SECURITY IS THE `a2a.send` DECISION, unchanged and consulted here with the
 * same resource shape `routeAgentMessage` uses. There is no second ACL: an
 * answer is a message to that worker, so it passes exactly when a message
 * would. Anything other than `allow` falls through to `routeAgentMessage`,
 * which re-decides and owns the deny and the hold card — so a policy that
 * holds messages between this pair holds the answer too, rather than being
 * bypassed by the narrower door.
 *
 * THE DEGRADE IS DELIBERATE. With no open question the answer is delivered as
 * an ordinary message and the tool is told so. It must never be written as a
 * `question_response` on spec: the poll loop skips system rows by kind, so a
 * response with no tool waiting is discarded in silence.
 */
import { getOpenQuestionForAgentGroup, deletePendingQuestion } from '../../db/sessions.js';
import { answerPendingQuestion } from '../interactive/answer.js';
import type { PendingQuestion } from '../../types.js';
import { guard, GuardDenyError } from '../../guard/index.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { routeAgentMessage } from './agent-route.js';
import { respondToBlockingTool } from './blocking-request.js';
import { a2aSend } from './guard.js';

/**
 * The bound used only for a row written before the deadline travelled.
 *
 * IT IS NOT THE CONTRACT ANY MORE, and the reason is worth keeping. This
 * number used to be the whole mechanism: a copy of the container's
 * `ESCALATED_TIMEOUT_S`, applied to `created_at`, with a comment asking the
 * two to move together. A comment cannot hold that. `ask_user_question` takes
 * a caller-supplied `timeout`, so the pair could be broken per call with
 * nothing wrong in either file — and even unbroken, the two clocks start at
 * different moments, because `created_at` is stamped a delivery poll after the
 * tool began waiting. Both gaps end the same way: the fast path writes a
 * `question_response` for a tool that has stopped listening, and the poll loop
 * drops it by kind.
 *
 * So the deadline now rides in the envelope and lands in `expires_at`
 * (migration 029). This remains for rows an older container wrote, which
 * carry no deadline and are still answerable — imprecisely, exactly as before.
 */
const LEGACY_QUESTION_TTL_MS = 600_000;

/**
 * Whether the tool that asked has stopped listening.
 *
 * Prefers the deadline the asking tool sent, because it is the only value that
 * knows what that tool actually passed. Falls back to the old derivation for a
 * pre-migration row rather than refusing it: those questions are real and a
 * worker mid-upgrade would otherwise be stranded.
 */
function questionHasExpired(pq: PendingQuestion): boolean {
  if (pq.expires_at) {
    const at = new Date(pq.expires_at).getTime();
    if (Number.isFinite(at)) return Date.now() >= at;
  }
  const age = Date.now() - new Date(pq.created_at).getTime();
  return !Number.isFinite(age) || age > LEGACY_QUESTION_TTL_MS;
}

/** How the request ended, as the container tool reads it. */
type AnswerStatus = 'answered' | 'delivered' | 'error';

interface AnswerRequest {
  requestId: string;
  worker: string;
  workerName: string;
  answer: string;
  waitUntil: number | null;
}

/** The container's payload, re-read on every entry. */
function parseRequest(content: Record<string, unknown>): AnswerRequest {
  const str = (key: string): string => (typeof content[key] === 'string' ? (content[key] as string).trim() : '');
  return {
    requestId: str('requestId'),
    worker: str('worker'),
    workerName: str('workerName') || str('worker'),
    answer: str('answer'),
    waitUntil: typeof content.waitUntil === 'number' ? content.waitUntil : null,
  };
}

/**
 * Answer the blocking tool. The envelope is shared (blocking-request.ts); what
 * is local here is the `type` and the `result`, which are this tool's contract.
 */
async function respond(session: Session, req: AnswerRequest, status: AnswerStatus, message: string): Promise<void> {
  await respondToBlockingTool(
    session,
    req,
    {
      id: `answer-resp-${req.requestId}`,
      type: 'answer_worker_response',
      status,
      result: status === 'error' ? { error: message } : { message },
    },
    message,
  );
}

/** Malformed payloads are answered without ever reaching the guard. */
export async function validateAnswerWorker(content: Record<string, unknown>, session: Session): Promise<boolean> {
  const req = parseRequest(content);
  if (!req.worker) {
    await respond(session, req, 'error', 'answer_worker failed: worker is required.');
    return false;
  }
  if (!req.answer) {
    await respond(session, req, 'error', 'answer_worker failed: answer is required.');
    return false;
  }
  return true;
}

export async function denyAnswerWorker(
  content: Record<string, unknown>,
  session: Session,
  reason: string,
): Promise<void> {
  await respond(session, parseRequest(content), 'error', `answer_worker denied: ${reason}`);
}

/**
 * Deliver the answer the long way — as an ordinary agent-to-agent message.
 *
 * Reached when there is no open question, when the recorded one has expired,
 * or when `a2a.send` did not plainly allow. In every case this is the honest
 * outcome and the tool is told which one it got, so the orchestrator can say
 * something true to the human rather than assuming the worker resumed.
 */
async function deliverAsMessage(session: Session, req: AnswerRequest, why: string): Promise<void> {
  try {
    const outcome = await routeAgentMessage(
      {
        id: `answer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        platform_id: req.worker,
        // This used to also carry an `answersQuestionId` tag, so the worker
        // could tell THIS batch was the answer it had stopped waiting for and
        // keep its transcript for it. The transcript is never dropped now — a
        // worker resumes like any other session — so nothing reads the tag and
        // it is not sent.
        content: JSON.stringify({ text: req.answer }),
        in_reply_to: null,
      },
      session,
    );
    await respond(
      session,
      req,
      'delivered',
      outcome === 'held'
        ? `"${req.workerName}" was not unblocked: ${why}, and the message is held for admin approval.`
        : `"${req.workerName}" was not waiting on a question (${why}), so this was delivered as an ordinary ` +
            `message. If it is still working it will read this as new instructions, not as an answer.`,
    );
  } catch (err) {
    if (err instanceof GuardDenyError) {
      await respond(session, req, 'error', `answer_worker failed: ${err.message}`);
      return;
    }
    throw err;
  }
}

export async function answerWorker(content: Record<string, unknown>, session: Session): Promise<void> {
  const req = parseRequest(content);

  // AUTHORIZE BEFORE TOUCHING ANY ROW. `req.worker` is re-read from the
  // container's payload on every entry, and the container is untrusted by
  // design — it can name any agent group id it likes. An earlier order looked
  // the question up and DELETED it on the expiry path before ever asking this,
  // so a caller holding no destination for the named group could still destroy
  // that group's pending question and only then be refused. The delete is not
  // recoverable: the asking tool waits out its bound and the answer is gone.
  //
  // Same decision `routeAgentMessage` makes, with the same resource shape.
  // Consulted here only to learn whether the fast path is open; a deny or a
  // hold is handed to routeAgentMessage, which owns both outcomes.
  const decision = await guard(a2aSend, {
    actor: { kind: 'agent', agentGroupId: session.agent_group_id, sessionId: session.id },
    resource: { from: session.agent_group_id, to: req.worker },
    payload: { id: req.requestId, platform_id: req.worker, content: req.answer, in_reply_to: null },
    grant: null,
  });
  if (decision.effect !== 'allow') {
    await deliverAsMessage(session, req, `it cannot be answered directly (${decision.reason})`);
    return;
  }

  const pq = await getOpenQuestionForAgentGroup(req.worker);
  if (!pq) {
    await deliverAsMessage(session, req, 'no question is open');
    return;
  }

  if (questionHasExpired(pq)) {
    // Drop the stale row so it cannot capture a later, unrelated answer. Safe
    // to do here and not above: the caller is authorized for this group.
    await deletePendingQuestion(pq.question_id);
    await deliverAsMessage(session, req, 'its question timed out');
    return;
  }

  // The SAME writer a button click uses, not a copy of it. That identity is
  // the seam: the blocked tool polls for one row shape and must not be able to
  // tell which lane produced it. Two copies agreeing today is not the same
  // property as one writer.
  const target = await answerPendingQuestion(pq, req.answer, '');
  if (!target) {
    await deliverAsMessage(session, req, 'the session that asked it is gone');
    return;
  }

  log.info('Worker question answered', {
    questionId: pq.question_id,
    from: session.agent_group_id,
    to: req.worker,
  });

  await respond(session, req, 'answered', `"${req.workerName}" was waiting on a question and is now unblocked.`);
}
