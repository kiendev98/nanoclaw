/** `worker_sessions` — one helper session per (repository, messaging group, thread). */
import { getDb } from '../../../db/connection.js';
import type { WorkerSession } from '../types.js';

/** An unthreaded chat is one conversation, so `''` rather than NULL. See migration 025. */
export function threadKey(threadId: string | null): string {
  return threadId ?? '';
}

export async function findWorkerSession(
  repoName: string,
  messagingGroupId: string,
  threadId: string | null,
): Promise<WorkerSession | undefined> {
  return getDb().get<WorkerSession>(
    'SELECT * FROM worker_sessions WHERE repo_name = ? AND messaging_group_id = ? AND thread_id = ?',
    repoName,
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
        principal_agent_group_id, principal_session_id, worktree_path, branch_name, created_at
      ) VALUES (
        @helper_session_id, @helper_agent_group_id, @repo_name, @messaging_group_id, @thread_id,
        @principal_agent_group_id, @principal_session_id, @worktree_path, @branch_name, @created_at
      )`,
    { ...row },
  );
}

/**
 * Re-point a reused helper session at the principal session that asked this
 * time.
 *
 * The same thread can resolve to a different principal session after a
 * `session_mode` change or a session reset, and the report must reach whoever
 * is holding the conversation now.
 */
export async function setWorkerSessionPrincipal(
  helperSessionId: string,
  principalAgentGroupId: string,
  principalSessionId: string,
): Promise<void> {
  await getDb().run(
    'UPDATE worker_sessions SET principal_agent_group_id = ?, principal_session_id = ? WHERE helper_session_id = ?',
    principalAgentGroupId,
    principalSessionId,
    helperSessionId,
  );
}
