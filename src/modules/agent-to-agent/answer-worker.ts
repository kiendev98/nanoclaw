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
import { getOpenQuestionForAgentGroup, deletePendingQuestion, getSession } from '../../db/sessions.js';
import { guard, GuardDenyError } from '../../guard/index.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { routeAgentMessage } from './agent-route.js';
import { callerStoppedWaiting, notifyAgent } from './blocking-request.js';
import { a2aSend } from './guard.js';

/**
 * How long a recorded question stays answerable.
 *
 * It mirrors `ESCALATED_TIMEOUT_S` in the container's interactive.ts, and the
 * two must move together: past the tool's own bound nothing is polling for a
 * `question_response`, so a row written then would be skipped by kind and lost.
 * Bounding the host on the same clock turns that loss into a plain message the
 * worker can still act on.
 *
 * Derived from `created_at` rather than stored, so this needs no column and no
 * migration, and the number stays beside the reasoning instead of in a row.
 */
const QUESTION_TTL_MS = 600_000;

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
 * Answer the blocking tool, and wake the requester when it has already given
 * up. Same contract as `spawn_worker`'s response: `kind: 'system'` and
 * non-triggering, found by `requestId`, skipped by the poll loop's kind
 * filter so it can never read as an unanswered wake.
 */
async function respond(session: Session, req: AnswerRequest, status: AnswerStatus, message: string): Promise<void> {
  if (req.requestId) {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `answer-resp-${req.requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({
        type: 'answer_worker_response',
        requestId: req.requestId,
        status,
        result: status === 'error' ? { error: message } : { message },
      }),
      trigger: false,
    });
  }
  if (callerStoppedWaiting(req.waitUntil)) await notifyAgent(session, message);
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

  const pq = await getOpenQuestionForAgentGroup(req.worker);
  if (!pq) {
    await deliverAsMessage(session, req, 'no question is open');
    return;
  }

  const age = Date.now() - new Date(pq.created_at).getTime();
  if (!Number.isFinite(age) || age > QUESTION_TTL_MS) {
    // Drop the stale row so it cannot capture a later, unrelated answer.
    await deletePendingQuestion(pq.question_id);
    await deliverAsMessage(session, req, 'its question timed out');
    return;
  }

  // The same decision `routeAgentMessage` makes, with the same resource shape.
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

  const target = await getSession(pq.session_id);
  if (!target) {
    await deletePendingQuestion(pq.question_id);
    await deliverAsMessage(session, req, 'the session that asked it is gone');
    return;
  }

  // Byte-identical to what a button click produces (modules/interactive), so
  // the waiting tool needs no second shape to recognise.
  await writeSessionMessage(target.agent_group_id, target.id, {
    id: `qr-${pq.question_id}-${Date.now()}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: pq.platform_id,
    channelType: pq.channel_type,
    threadId: pq.thread_id,
    content: JSON.stringify({
      type: 'question_response',
      questionId: pq.question_id,
      selectedOption: req.answer,
      userId: '',
    }),
  });
  await deletePendingQuestion(pq.question_id);

  log.info('Worker question answered', {
    questionId: pq.question_id,
    from: session.agent_group_id,
    to: req.worker,
  });

  // The worker is normally mid-poll and already awake. The wake is for the
  // case it is not: a container reaped between the question and the answer
  // still finds the response row on its first poll.
  await requestWake(target, 'interactive');

  await respond(session, req, 'answered', `"${req.workerName}" was waiting on a question and is now unblocked.`);
}
