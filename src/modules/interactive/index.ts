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
import { getPendingQuestion } from '../../db/sessions.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { answerPendingQuestion } from './answer.js';

async function handleInteractiveResponse(payload: ResponsePayload): Promise<boolean> {
  if (!(await hasTable(getDb(), 'pending_questions'))) return false;

  const pq = await getPendingQuestion(payload.questionId);
  if (!pq) return false;

  const session = await answerPendingQuestion(pq, payload.value, payload.userId ?? '');
  // Claimed either way: this questionId was ours, and a vanished session does
  // not hand it back to another handler.
  if (!session) return true;

  log.info('Question response routed', {
    questionId: payload.questionId,
    selectedOption: payload.value,
    sessionId: session.id,
  });
  return true;
}

registerResponseHandler(handleInteractiveResponse);
