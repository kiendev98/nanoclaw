/**
 * `worker_questions` — a helper's open question.
 *
 * A row is deleted on a real answer, or when its task ends. It is never deleted
 * by a clock: `ask_principal` does not block and carries no deadline, so no
 * message can be destroyed by one passing.
 */
import { getDb } from '../../../db/connection.js';
import type { WorkerQuestion } from '../types.js';

export async function createQuestion(question: WorkerQuestion): Promise<void> {
  await getDb().run(
    `INSERT INTO worker_questions (
        question_id, task_id, helper_session_id, helper_agent_group_id,
        principal_agent_group_id, principal_session_id, question_text, created_at
      ) VALUES (
        @question_id, @task_id, @helper_session_id, @helper_agent_group_id,
        @principal_agent_group_id, @principal_session_id, @question_text, @created_at
      )`,
    { ...question },
  );
}

export async function getQuestion(questionId: string): Promise<WorkerQuestion | undefined> {
  return getDb().get<WorkerQuestion>('SELECT * FROM worker_questions WHERE question_id = ?', questionId);
}

/** The one open question a helper session may hold. Blocks a second ask (C9). */
export async function findOpenQuestion(helperSessionId: string): Promise<WorkerQuestion | undefined> {
  return getDb().get<WorkerQuestion>(
    'SELECT * FROM worker_questions WHERE helper_session_id = ? ORDER BY created_at LIMIT 1',
    helperSessionId,
  );
}

/** Consume a question by answering it. False when another answer got there first. */
export async function consumeQuestion(questionId: string): Promise<boolean> {
  const result = await getDb().run('DELETE FROM worker_questions WHERE question_id = ?', questionId);
  return result.changes > 0;
}

export async function deleteQuestionsForTask(taskId: string): Promise<void> {
  await getDb().run('DELETE FROM worker_questions WHERE task_id = ?', taskId);
}
