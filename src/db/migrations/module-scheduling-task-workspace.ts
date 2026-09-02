import type Database from 'better-sqlite3';

import type { ModuleMigration } from './index.js';

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
 * It also makes the binding lifecycle free. Every lookup here filters
 * `status = 'active'`, so when `shouldCloseTaskSession` closes a spent task
 * session its binding stops matching on the same tick. No cleanup job, no
 * orphan rows, no expiry policy to get wrong.
 *
 * WHY AN OWNER-QUALIFIED NAME. A built-in `027-` would collide with whatever
 * upstream numbers next, and this fork has to merge upstream forever. The
 * `module:` namespace is reserved for exactly that, so this migration can
 * never contend with a core number.
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

export const moduleSchedulingTaskWorkspace: ModuleMigration = {
  version: 27,
  name: 'module:scheduling:task-workspace',
  sqliteOnly: true,
  // Deleting an agent group means deleting eleven tables' worth of children in
  // dependency order. The runner re-enables enforcement and runs
  // `foreign_key_check` inside the transaction, so a row missed below rolls
  // the whole migration back rather than leaving a dangling reference.
  disableForeignKeys: true,
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN workspace_path            TEXT;
      ALTER TABLE sessions ADD COLUMN bound_messaging_group_id  TEXT;
      ALTER TABLE sessions ADD COLUMN bound_root_message_id     TEXT;
      CREATE INDEX idx_sessions_bound
        ON sessions(bound_messaging_group_id, bound_root_message_id);
    `);

    // Children of the worker SESSIONS first: they reference rows deleted in
    // the next statement.
    db.exec(`
      DELETE FROM pending_approvals WHERE session_id IN (${WORKER_SESSIONS});
      DELETE FROM pending_questions WHERE session_id IN (${WORKER_SESSIONS});
      DELETE FROM sessions         WHERE agent_group_id IN (${WORKER_GROUPS});
    `);

    // `agent_destinations.target_id` is polymorphic, so it carries no foreign
    // key and `foreign_key_check` cannot catch a row left pointing at a
    // deleted worker. It is cleared explicitly for that reason: a stale row
    // would keep resolving a `send_message` handle to a group that is gone.
    db.exec(`
      DELETE FROM agent_destinations
       WHERE agent_group_id IN (${WORKER_GROUPS})
          OR (target_type = 'agent' AND target_id IN (${WORKER_GROUPS}));
    `);

    db.exec(`
      DELETE FROM agent_group_members       WHERE agent_group_id IN (${WORKER_GROUPS});
      DELETE FROM container_configs         WHERE agent_group_id IN (${WORKER_GROUPS});
      DELETE FROM messaging_group_agents    WHERE agent_group_id IN (${WORKER_GROUPS});
      DELETE FROM pending_approvals         WHERE agent_group_id IN (${WORKER_GROUPS});
      DELETE FROM pending_channel_approvals WHERE agent_group_id IN (${WORKER_GROUPS});
      DELETE FROM pending_sender_approvals  WHERE agent_group_id IN (${WORKER_GROUPS});
      DELETE FROM user_roles                WHERE agent_group_id IN (${WORKER_GROUPS});
      DELETE FROM agent_message_policies
       WHERE from_agent_group_id IN (${WORKER_GROUPS})
          OR to_agent_group_id   IN (${WORKER_GROUPS});
    `);

    db.exec(`DELETE FROM agent_groups WHERE origin_session_id IS NOT NULL;`);
  },
};
