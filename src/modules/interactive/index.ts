/**
 * Interactive module — generic ask_user_question flow.
 *
 * Container-side `ask_user_question` writes a chat-sdk card to outbound.db +
 * polls inbound.db for a `question_response` system message. On the host side
 * this module handles the button-click response: look up the pending_questions
 * row, write the response into the session's inbound.db, wake the container.
 *
 * The `createPendingQuestion` call in `deliverMessage` (delivery.ts) stays
 * inline in core — it's 15 lines guarded by `hasTable('pending_questions')`,
 * modularizing it adds more registry surface than it saves.
 */
import { getDb, hasTable } from '../../db/connection.js';
import { deletePendingQuestion, getPendingQuestion, getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';

/**
 * Deliver an answer to whichever session is blocked on `questionId`.
 *
 * THE TARGET COMES FROM THE PENDING ROW, never from where the answer arrived.
 * That is what lets an answer reach a headless task run: a button click in the
 * channel and an `answer_task_question` call relayed through the run's
 * requester are the same operation to everything downstream, so both doors
 * share this one implementation rather than each writing the row themselves.
 *
 * @returns false when no such question is pending — already answered, expired,
 *   or never ours to claim.
 */
export async function deliverQuestionResponse(questionId: string, value: string, userId: string): Promise<boolean> {
  if (!(await hasTable(getDb(), 'pending_questions'))) return false;

  const pq = await getPendingQuestion(questionId);
  if (!pq) return false;

  const session = await getSession(pq.session_id);
  if (!session) {
    log.warn('Session not found for pending question', { questionId, sessionId: pq.session_id });
    await deletePendingQuestion(questionId);
    return true; // claimed — we owned this questionId even though the session is gone
  }

  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `qr-${questionId}-${Date.now()}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: pq.platform_id,
    channelType: pq.channel_type,
    threadId: pq.thread_id,
    content: JSON.stringify({
      type: 'question_response',
      questionId,
      selectedOption: value,
      userId,
    }),
  });

  await deletePendingQuestion(questionId);
  log.info('Question response routed', { questionId, selectedOption: value, sessionId: session.id });

  await requestWake(session, 'interactive');
  return true;
}

async function handleInteractiveResponse(payload: ResponsePayload): Promise<boolean> {
  return deliverQuestionResponse(payload.questionId, payload.value, payload.userId ?? '');
}

registerResponseHandler(handleInteractiveResponse);
