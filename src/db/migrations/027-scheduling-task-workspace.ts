import type { Migration } from './index.js';

/**
 * Task-scoped workspaces, and the removal of the worker agent groups they
 * replace.
 *
 * THREE COLUMNS ON `sessions`, AND NO NEW TABLE. `sessions` already is the
 * thread-to-session map — `idx_sessions_lookup (messaging_group_id,
 * thread_id)` is that map's index. A separate `thread_bindings` table would be
 * a second map that can disagree with the first, and the disagreement would
 * surface as an agent answering in a thread it does not believe it owns.
 *
 * It also makes the binding lifecycle free. Every lookup filters
 * `status = 'active'`, so when `shouldCloseTaskSession` closes a spent task
 * session its binding stops matching on the same tick. No cleanup job, no
 * orphan rows, no expiry policy to get wrong.
 *
 * PORTABLE, AND A BUILT-IN RATHER THAN A REGISTERED MODULE MIGRATION. Both
 * were forced by policy, and both policies are right. `registerMigration`
 * only fires when the modules barrel is imported — the host entry point alone
 * — so a registered migration is invisible to every test and to any tool that
 * opens the database without booting the host. And `registry.test.ts` reserves
 * the `module:` name prefix away from built-ins, while `portability.test.ts`
 * freezes `sqliteOnly` to a pre-boundary set, so a new built-in has to speak
 * the abstract driver.
 *
 * WHAT IS DELIBERATELY LEFT ALONE. `agent_groups.workspace_path` and
 * `agent_groups.origin_session_id` stay. Dropping them would falsify
 * migrations 025 and 026 — a released migration's identity is permanent — and
 * an unread column costs nothing. Migration 026 itself is history and is never
 * edited.
 */

/** Every agent group that exists only because `spawn_worker` created it. */
const WORKER_GROUPS = `SELECT id FROM agent_groups WHERE origin_session_id IS NOT NULL`;
const WORKER_SESSIONS = `SELECT id FROM sessions WHERE agent_group_id IN (${WORKER_GROUPS})`;

export const migration027: Migration = {
  version: 27,
  name: 'scheduling-task-workspace',
  async up(db) {
    await db.exec(`ALTER TABLE sessions ADD COLUMN workspace_path TEXT;`);
    await db.exec(`ALTER TABLE sessions ADD COLUMN bound_messaging_group_id TEXT;`);
    await db.exec(`ALTER TABLE sessions ADD COLUMN bound_root_message_id TEXT;`);
    await db.exec(`CREATE INDEX idx_sessions_bound ON sessions(bound_messaging_group_id, bound_root_message_id);`);

    // Children before parents throughout, so foreign keys stay satisfied at
    // every step and the runner's `foreign_key_check` has nothing to find.
    // Deleting the groups is safe by construction: `spawn_worker` is gone, so
    // nothing can create another and nothing reads the ones left behind.
    await db.exec(`DELETE FROM pending_approvals WHERE session_id IN (${WORKER_SESSIONS});`);
    await db.exec(`DELETE FROM pending_questions WHERE session_id IN (${WORKER_SESSIONS});`);
    await db.exec(`DELETE FROM sessions WHERE agent_group_id IN (${WORKER_GROUPS});`);

    // `agent_destinations.target_id` is polymorphic, so it carries no foreign
    // key and `foreign_key_check` cannot catch a row left pointing at a
    // deleted worker. Cleared explicitly for that reason: a stale row would
    // keep resolving a `send_message` handle to a group that is gone.
    await db.exec(
      `DELETE FROM agent_destinations
        WHERE agent_group_id IN (${WORKER_GROUPS})
           OR (target_type = 'agent' AND target_id IN (${WORKER_GROUPS}));`,
    );

    await db.exec(`DELETE FROM agent_group_members WHERE agent_group_id IN (${WORKER_GROUPS});`);
    await db.exec(`DELETE FROM container_configs WHERE agent_group_id IN (${WORKER_GROUPS});`);
    await db.exec(`DELETE FROM messaging_group_agents WHERE agent_group_id IN (${WORKER_GROUPS});`);
    await db.exec(`DELETE FROM pending_approvals WHERE agent_group_id IN (${WORKER_GROUPS});`);
    await db.exec(`DELETE FROM pending_channel_approvals WHERE agent_group_id IN (${WORKER_GROUPS});`);
    await db.exec(`DELETE FROM pending_sender_approvals WHERE agent_group_id IN (${WORKER_GROUPS});`);
    await db.exec(`DELETE FROM user_roles WHERE agent_group_id IN (${WORKER_GROUPS});`);
    await db.exec(
      `DELETE FROM agent_message_policies
        WHERE from_agent_group_id IN (${WORKER_GROUPS})
           OR to_agent_group_id IN (${WORKER_GROUPS});`,
    );

    await db.exec(`DELETE FROM agent_groups WHERE origin_session_id IS NOT NULL;`);
  },
};
