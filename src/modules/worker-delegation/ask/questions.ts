/**
 * A helper asks its principal, and the principal answers.
 *
 * `ask_principal` does not block and carries no deadline. The helper ends its
 * turn; the answer arrives as an ordinary inbound message and wakes it again.
 * That is what makes C6 free: arrival order decides nothing, because an answer
 * is matched by question id and new work arrives through an unrelated door.
 *
 * With no deadline there is nothing to expire, so nothing can be destroyed by a
 * missed one — C8's guarantee holds by construction rather than by a rule about
 * late answers.
 */
import { log } from '../../../log.js';
import type { Session } from '../../../types.js';
import { consumeQuestion, createQuestion, findOpenQuestion, getQuestion } from '../db/worker-questions.js';
import { findRunningTask } from '../db/worker-tasks.js';
import { generateId } from '../ids.js';
import { deliverToSession, replyToCaller } from '../notify.js';
import type { WorkerQuestion } from '../types.js';

/** Called on a HELPER session. */
export async function askPrincipal(content: Record<string, unknown>, session: Session): Promise<void> {
  const questionText = typeof content.question === 'string' ? content.question.trim() : '';
  if (!questionText) {
    await replyToCaller(session, 'ask_principal failed: the question is empty.');
    return;
  }

  const task = await findRunningTask(session.id);
  if (!task) {
    await replyToCaller(session, 'ask_principal failed: there is no running task on this session.');
    return;
  }

  // C9: one open question at a time. A helper that has asked waits for an
  // answer rather than asking again.
  const open = await findOpenQuestion(session.id);
  if (open) {
    await replyToCaller(
      session,
      `ask_principal failed: you are already waiting on question ${open.question_id}. Say what you are blocked on and stop.`,
    );
    return;
  }

  const question: WorkerQuestion = {
    question_id: generateId('wq'),
    task_id: task.task_id,
    helper_session_id: session.id,
    helper_agent_group_id: task.helper_agent_group_id,
    principal_agent_group_id: task.principal_agent_group_id,
    principal_session_id: task.principal_session_id,
    question_text: questionText,
    created_at: new Date().toISOString(),
  };
  await createQuestion(question);

  await deliverToSession(
    task.principal_agent_group_id,
    task.principal_session_id,
    [
      `Question from the ${task.repo_name} worker (question ${question.question_id}):`,
      '',
      questionText,
      '',
      `Answer it with answer_worker_question({ questionId: "${question.question_id}", answer: "..." }).`,
    ].join('\n'),
    `${task.repo_name}-worker`,
  );
  log.info('Worker question raised', { questionId: question.question_id, taskId: task.task_id });
}

/**
 * Called on a PRINCIPAL session.
 *
 * A distinct action verified against a specific question id, so an ordinary
 * message can never be mistaken for an answer (C5).
 */
export async function answerWorkerQuestion(content: Record<string, unknown>, session: Session): Promise<void> {
  const questionId = typeof content.questionId === 'string' ? content.questionId.trim() : '';
  const answer = typeof content.answer === 'string' ? content.answer.trim() : '';
  if (!questionId || !answer) {
    await replyToCaller(session, 'answer_worker_question failed: both questionId and answer are required.');
    return;
  }

  const question = await getQuestion(questionId);
  if (!question) {
    await replyToCaller(session, `answer_worker_question failed: question ${questionId} is not open.`);
    return;
  }
  if (question.principal_agent_group_id !== session.agent_group_id) {
    await replyToCaller(session, `answer_worker_question failed: question ${questionId} was not asked of you.`);
    log.warn('Worker question answered by the wrong principal', { questionId, by: session.agent_group_id });
    return;
  }
  if (!(await consumeQuestion(questionId))) {
    await replyToCaller(session, `answer_worker_question failed: question ${questionId} was already answered.`);
    return;
  }

  // The question travels with the answer, so the helper reads both together
  // however long it waited.
  await deliverToSession(
    question.helper_agent_group_id,
    question.helper_session_id,
    [`Answer to your question ${questionId}:`, '', `> ${question.question_text}`, '', answer].join('\n'),
    'principal',
  );
  await replyToCaller(session, `Answer delivered to the worker (question ${questionId}).`);
}
