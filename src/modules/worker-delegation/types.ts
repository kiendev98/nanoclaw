/** Row shapes for the worker-delegation tables (migration 025). */

/** One per repository. The agent group, and therefore the memory, is per repo. */
export interface WorkerHelper {
  helper_agent_group_id: string;
  repo_name: string;
  repo_path: string;
  created_at: string;
}

/**
 * One per (repository, messaging group, thread) — the A4 reuse key.
 *
 * Keyed on the thread rather than the principal's session id, because
 * `session_mode` decides how a thread maps to a session and this key must be
 * invariant to it. `thread_id` is `''` for an unthreaded chat.
 */
export interface WorkerSession {
  helper_session_id: string;
  helper_agent_group_id: string;
  repo_name: string;
  messaging_group_id: string;
  thread_id: string;
  principal_agent_group_id: string;
  principal_session_id: string;
  worktree_path: string;
  branch_name: string;
  created_at: string;
}

export type WorkerTaskStatus = 'running' | 'answered';

export interface WorkerTask {
  task_id: string;
  helper_session_id: string;
  helper_agent_group_id: string;
  repo_name: string;
  principal_agent_group_id: string;
  principal_session_id: string;
  description: string;
  status: WorkerTaskStatus;
  draft_answer: string | null;
  progress_note_count: number;
  last_progress_note_at: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface WorkerQuestion {
  question_id: string;
  task_id: string;
  helper_session_id: string;
  helper_agent_group_id: string;
  principal_agent_group_id: string;
  principal_session_id: string;
  question_text: string;
  created_at: string;
}

export interface WorkerChannelGrant {
  task_id: string;
  helper_agent_group_id: string;
  helper_session_id: string;
  messaging_group_id: string;
  channel_type: string;
  platform_id: string;
  /** The outbound message whose delivery starts the thread. */
  root_message_id: string;
  /** `''` until that root post is delivered and the platform names its thread. */
  thread_id: string;
  local_destination_name: string;
  granted_by_session_id: string;
  granted_at: string;
  released_at: string | null;
}
