/**
 * Write the answer to a pending question into the session that asked it.
 *
 * THE ROW IS THE SEAM, so it has exactly one writer. A blocked
 * `ask_user_question` polls `findQuestionResponse` for a `question_response`
 * and cannot tell — must not be able to tell — whether a person clicked a
 * button or an orchestrator called `answer_worker`. That is the entire basis
 * for the claim that an escalated answer is a return value rather than a
 * message, and it holds only while both producers emit the same five fields
 * with the same id shape and the same tail.
 *
 * They used to be two independent copies, one per module, with nothing keeping
 * them in step. A field added on the button path, or `selectedOption` renamed,
 * would have broken the worker lane alone — at runtime, in a lane that has no
 * human watching it, which is the definition of this feature's failure mode.
 *
 * It lives here rather than in `index.ts` because importing that module runs
 * its `registerResponseHandler` side effect, and the agent-to-agent module has
 * no business registering the interactive module's handler by importing a
 * function from it.
 *
 * @returns The session that was answered, or undefined when it no longer
 *   exists — in which case the pending row is still consumed, because the
 *   question was ours to answer whether or not anyone is left to hear it.
 */
import { deletePendingQuestion, getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingQuestion, Session } from '../../types.js';

export async function answerPendingQuestion(
  pq: PendingQuestion,
  selectedOption: string,
  userId: string,
): Promise<Session | undefined> {
  const session = await getSession(pq.session_id);
  if (!session) {
    log.warn('Session not found for pending question', {
      questionId: pq.question_id,
      sessionId: pq.session_id,
    });
    await deletePendingQuestion(pq.question_id);
    return undefined;
  }

  // `kind: 'system'`, so the poll loop filters it out of agent prompts and it
  // can never read as an unanswered wake. The address fields come from the
  // pending row rather than from the session, because the answer belongs where
  // the question was asked.
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `qr-${pq.question_id}-${Date.now()}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: pq.platform_id,
    channelType: pq.channel_type,
    threadId: pq.thread_id,
    content: JSON.stringify({
      type: 'question_response',
      questionId: pq.question_id,
      selectedOption,
      userId,
    }),
  });

  await deletePendingQuestion(pq.question_id);

  // The asker is normally mid-poll and already awake. The wake is for the case
  // it is not: a container reaped between question and answer still finds the
  // response row on its first poll.
  await requestWake(session, 'interactive');
  return session;
}
