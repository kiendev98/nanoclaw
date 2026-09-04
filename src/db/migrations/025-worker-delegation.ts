import type { Migration } from './index.js';

/**
 * Worker delegation — an assistant hands a task to a helper that works inside
 * another repository.
 *
 * Four tables, one key each, deliberately not folded into `agent_groups` or
 * `sessions`. An earlier removed implementation bolted this feature's state
 * onto those two, and six dead columns are still the residue.
 *
 * - `worker_helpers` — one row per repository. The agent group is per repo, so
 *   `groups/` holds one folder per repo and memory is shared across its
 *   threads.
 * - `worker_sessions` — one row per (repo, messaging group, thread). This is
 *   the A4 reuse key and the A5 separation key. It is keyed on the THREAD, not
 *   on the principal's session id, because `session_mode` decides how a thread
 *   maps to a principal session and this key must be invariant to it.
 *   `thread_id` is `''` for an unthreaded chat: SQLite treats NULLs as distinct
 *   in a UNIQUE index, which would defeat the reuse this key exists for.
 * - `worker_tasks` — one row per delegated task. `draft_answer` is overwritten
 *   every turn and read once at finalize.
 * - `worker_questions` — a helper's open question. Deleted only on a real
 *   answer, never on a deadline, so a late answer still finds its question.
 * - `worker_channel_grants` — one lent conversation. `thread_id` is `''` until
 *   the root post is delivered and the platform names the thread it started.
 */
export const migration025: Migration = {
  version: 25,
  name: 'worker-delegation',
  async up(db) {
    await db.exec(`
      CREATE TABLE worker_helpers (
        helper_agent_group_id TEXT PRIMARY KEY,
        repo_name TEXT NOT NULL UNIQUE,
        repo_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE worker_sessions (
        helper_session_id TEXT PRIMARY KEY,
        helper_agent_group_id TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        principal_agent_group_id TEXT NOT NULL,
        principal_session_id TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (repo_name, messaging_group_id, thread_id)
      );
      CREATE INDEX idx_worker_sessions_group ON worker_sessions(helper_agent_group_id);

      CREATE TABLE worker_tasks (
        task_id TEXT PRIMARY KEY,
        helper_session_id TEXT NOT NULL,
        helper_agent_group_id TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        principal_agent_group_id TEXT NOT NULL,
        principal_session_id TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        draft_answer TEXT,
        progress_note_count INTEGER NOT NULL DEFAULT 0,
        last_progress_note_at TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX idx_worker_tasks_session_status ON worker_tasks(helper_session_id, status);

      CREATE TABLE worker_questions (
        question_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        helper_session_id TEXT NOT NULL,
        helper_agent_group_id TEXT NOT NULL,
        principal_agent_group_id TEXT NOT NULL,
        principal_session_id TEXT NOT NULL,
        question_text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_worker_questions_task ON worker_questions(task_id);

      CREATE TABLE worker_channel_grants (
        task_id TEXT PRIMARY KEY,
        helper_agent_group_id TEXT NOT NULL,
        helper_session_id TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        platform_id TEXT NOT NULL,
        root_message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        local_destination_name TEXT NOT NULL,
        granted_by_session_id TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        released_at TEXT
      );
      CREATE INDEX idx_worker_grants_live ON worker_channel_grants(helper_session_id, released_at);
      CREATE INDEX idx_worker_grants_thread ON worker_channel_grants(messaging_group_id, thread_id, released_at);
    `);
  },
};
