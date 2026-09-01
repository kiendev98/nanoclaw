import type { Migration } from './index.js';

/**
 * `origin_session_id` on `agent_groups` — the session a repo-scoped worker was
 * created for.
 *
 * Commit e50ed7a7 gave a worker its working directory (`workspace_path`). This
 * gives it the other half of its identity: WHOSE work it is doing. A worker
 * exists for one repository AND one conversation, and without the second half
 * three things are impossible.
 *
 * REUSE. A second `create_agent({ repo })` in the same thread would otherwise
 * mint a second worker on a second branch, which cannot see the first one's
 * work. `(origin_session_id, workspace_path)` is the pair that says "this
 * worker already exists", and `workspace_path` is itself derived from
 * `(repo, origin_session_id)` — so the pair is exactly the (repo, thread) key.
 *
 * RELAY. A worker's reply must land in the human's thread, and the thread must
 * not be something the worker can name: it is read from THIS column's session
 * row, so a worker can only ever reach the one conversation it was created for.
 *
 * REAPING. "The originating thread is done with it" is a question about this
 * column. Without it a worker is unreachable garbage that nothing can identify
 * as garbage.
 *
 * NULL means "not a worker" — an ordinary agent group, which is every group
 * that predates this column. No backfill, and a NULL row behaves exactly as it
 * did before.
 *
 * Deliberately NOT a foreign key to `sessions(id)`. The origin session is
 * expected to outlive nothing: it closes, and the reaper's whole job is to
 * notice that. An FK with ON DELETE CASCADE would delete the WORKER when its
 * origin session row is deleted, silently orphaning a worktree that may hold
 * uncommitted work — the exact outcome src/worktree.ts refuses to cause.
 */
export const migration026: Migration = {
  version: 26,
  name: 'agent-group-origin-session',
  async up(db) {
    await db.exec(`ALTER TABLE agent_groups ADD COLUMN origin_session_id TEXT;`);
    // The reuse lookup runs on every `create_agent({ repo })`, and the reaper
    // scans for non-NULL rows once per sweep tick. Both are covered by one
    // index on the discriminating column.
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_agent_groups_origin_session ON agent_groups(origin_session_id) WHERE origin_session_id IS NOT NULL;`,
    );
  },
};
