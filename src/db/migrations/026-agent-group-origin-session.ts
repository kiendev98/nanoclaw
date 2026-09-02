import type { Migration } from './index.js';

/**
 * `origin_session_id` on `agent_groups` — the session a repo-scoped worker was
 * created for.
 *
 * Commit e50ed7a7 gave a worker its working directory (`workspace_path`). This
 * gives it the other half of its identity: WHOSE work it is doing. A worker
 * exists for one repository AND one conversation, and the pair is the REUSE
 * key.
 *
 * A second `spawn_worker` for the same repo in the same thread would otherwise mint a
 * second worker on a second branch, which cannot see the first one's work.
 * `(origin_session_id, workspace_path)` is the pair that says "this worker
 * already exists", and `workspace_path` is itself derived from
 * `(repo, origin_session_id)` — so the pair is exactly the (repo, thread) key.
 *
 * NULL means "not a worker" — an ordinary agent group, which is every group
 * that predates this column. No backfill, and a NULL row behaves exactly as it
 * did before.
 *
 * Deliberately NOT a foreign key to `sessions(id)`. A worker outlives the
 * conversation that asked for it, on purpose: nothing retires one
 * automatically, and `ncl groups delete` is the way to remove it by hand. An FK
 * with ON DELETE CASCADE would delete the WORKER when its origin session row is
 * deleted, silently orphaning a worktree that may hold uncommitted work.
 */
export const migration026: Migration = {
  version: 26,
  name: 'agent-group-origin-session',
  async up(db) {
    await db.exec(`ALTER TABLE agent_groups ADD COLUMN origin_session_id TEXT;`);
    // The reuse lookup runs on every `spawn_worker`, on the
    // discriminating column.
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_agent_groups_origin_session ON agent_groups(origin_session_id) WHERE origin_session_id IS NOT NULL;`,
    );
  },
};
