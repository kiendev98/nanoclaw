/** `worker_sessions` — one worker session per (worker agent group, messaging group, thread). */
import { getDb } from '../../../db/connection.js';
import type { WorkerSession } from '../types.js';

/** An unthreaded chat is one conversation, so `''` rather than NULL. See migration 025. */
export function threadKey(threadId: string | null): string {
  return threadId ?? '';
}

/**
 * The worker session for one conversation.
 *
 * Keyed on the worker's agent group rather than the repository name, because a
 * repository has one worker per principal. Two principals wired to the same
 * thread would otherwise collide on one session.
 */
export async function findWorkerSession(
  helperAgentGroupId: string,
  messagingGroupId: string,
  threadId: string | null,
): Promise<WorkerSession | undefined> {
  return getDb().get<WorkerSession>(
    'SELECT * FROM worker_sessions WHERE helper_agent_group_id = ? AND messaging_group_id = ? AND thread_id = ?',
    helperAgentGroupId,
    messagingGroupId,
    threadKey(threadId),
  );
}

export async function getWorkerSession(helperSessionId: string): Promise<WorkerSession | undefined> {
  return getDb().get<WorkerSession>('SELECT * FROM worker_sessions WHERE helper_session_id = ?', helperSessionId);
}

export async function createWorkerSession(row: WorkerSession): Promise<void> {
  await getDb().run(
    `INSERT INTO worker_sessions (
        helper_session_id, helper_agent_group_id, repo_name, messaging_group_id, thread_id,
        worktree_path, branch_name, created_at
      ) VALUES (
        @helper_session_id, @helper_agent_group_id, @repo_name, @messaging_group_id, @thread_id,
        @worktree_path, @branch_name, @created_at
      )`,
    { ...row },
  );
}
