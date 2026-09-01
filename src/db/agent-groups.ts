import type { AgentGroup } from '../types.js';
import { getDb, hasTable } from './connection.js';

export async function createAgentGroup(group: AgentGroup): Promise<void> {
  await getDb().run(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, workspace_path, origin_session_id)
     VALUES (@id, @name, @folder, @agent_provider, @created_at, @workspace_path, @origin_session_id)`,
    // Spread-then-default rather than passing `group` straight through: named
    // binding throws on a missing key, and both optional columns are optional
    // on the type precisely because absence is the normal case.
    {
      ...group,
      workspace_path: group.workspace_path ?? null,
      origin_session_id: group.origin_session_id ?? null,
    },
  );
}

export async function getAgentGroup(id: string): Promise<AgentGroup | undefined> {
  return getDb().get<AgentGroup>('SELECT * FROM agent_groups WHERE id = ?', id);
}

export async function getAgentGroupByFolder(folder: string): Promise<AgentGroup | undefined> {
  return getDb().get<AgentGroup>('SELECT * FROM agent_groups WHERE folder = ?', folder);
}

export async function getAllAgentGroups(): Promise<AgentGroup[]> {
  return getDb().all<AgentGroup>('SELECT * FROM agent_groups ORDER BY name');
}

/**
 * The worker a given (repo, thread) pair already has, if any.
 *
 * `workspacePath` is a pure function of the resolved repository and the origin
 * session (see `workerWorkspace` in the agent-to-agent module), so the two
 * arguments together are the (repo, thread) key — not two independent filters.
 * Matching on both rather than on `origin_session_id` alone is what lets ONE
 * thread hold one worker PER repository.
 */
export async function findWorkerForOrigin(
  originSessionId: string,
  workspacePath: string,
): Promise<AgentGroup | undefined> {
  return getDb().get<AgentGroup>(
    'SELECT * FROM agent_groups WHERE origin_session_id = ? AND workspace_path = ?',
    originSessionId,
    workspacePath,
  );
}

export async function updateAgentGroup(
  id: string,
  updates: Partial<Pick<AgentGroup, 'name' | 'agent_provider' | 'workspace_path' | 'origin_session_id'>>,
): Promise<void> {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  await getDb().run(`UPDATE agent_groups SET ${fields.join(', ')} WHERE id = @id`, values);
}

export async function deleteAgentGroup(id: string): Promise<void> {
  await getDb().run('DELETE FROM agent_groups WHERE id = ?', id);
}

/** What `deleteAgentGroupCascade` removed, per table. */
export interface AgentGroupCascadeCounts {
  sessions: number;
  pending_questions: number;
  pending_approvals: number;
  agent_destinations_owned: number;
  agent_destinations_pointing: number;
  pending_sender_approvals: number;
  pending_channel_approvals: number;
  messaging_group_agents: number;
  agent_group_members: number;
  user_roles: number;
  container_configs: number;
}

/**
 * Delete an agent group and every row that depends on it, FK-ordered, in one
 * transaction (#2525).
 *
 * `ncl groups delete` is the caller. It is one function rather than an inline
 * statement list because a second hand-written cascade is how a table gets
 * missed in one copy and left dangling.
 *
 * OUT OF SCOPE, deliberately: killing running containers, and on-disk cleanup of `groups/<folder>/` or `data/v2-sessions/<group-id>/`. The
 * leftover `groups/<folder>/` is what stops a later create from adopting a dead
 * group's data under a new identity.
 *
 * The caller verifies the group exists — an unknown id is a caller-level error
 * with a caller-level message, and every count here would simply be zero.
 *
 * @returns Per-table counts, sourced from each DELETE's `changes`, so they
 *   describe what the transaction did rather than a pre-flight snapshot.
 */
export async function deleteAgentGroupCascade(id: string): Promise<AgentGroupCascadeCounts> {
  const db = getDb();
  const hasAgentDestinations = await hasTable(db, 'agent_destinations');
  const hasPendingApprovals = await hasTable(db, 'pending_approvals');

  // The async driver transaction rolls the whole thing back if any statement
  // throws (e.g. an FK constraint we missed), so the central DB stays
  // consistent.
  return db.transaction(async () => {
    const counts: AgentGroupCascadeCounts = {
      sessions: 0,
      pending_questions: 0,
      pending_approvals: 0,
      agent_destinations_owned: 0,
      agent_destinations_pointing: 0,
      pending_sender_approvals: 0,
      pending_channel_approvals: 0,
      messaging_group_agents: 0,
      agent_group_members: 0,
      user_roles: 0,
      container_configs: 0,
    };

    if (hasAgentDestinations) {
      counts.agent_destinations_owned = (
        await db.run('DELETE FROM agent_destinations WHERE agent_group_id = ?', id)
      ).changes;
      counts.agent_destinations_pointing = (
        await db.run('DELETE FROM agent_destinations WHERE target_type = ? AND target_id = ?', 'agent', id)
      ).changes;
    }
    counts.pending_questions = (
      await db.run(
        'DELETE FROM pending_questions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
        id,
      )
    ).changes;
    if (hasPendingApprovals) {
      counts.pending_approvals = (
        await db.run(
          'DELETE FROM pending_approvals WHERE agent_group_id = ? OR session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
          id,
          id,
        )
      ).changes;
    }
    counts.sessions = (await db.run('DELETE FROM sessions WHERE agent_group_id = ?', id)).changes;
    counts.pending_sender_approvals = (
      await db.run('DELETE FROM pending_sender_approvals WHERE agent_group_id = ?', id)
    ).changes;
    counts.pending_channel_approvals = (
      await db.run('DELETE FROM pending_channel_approvals WHERE agent_group_id = ?', id)
    ).changes;
    counts.messaging_group_agents = (
      await db.run('DELETE FROM messaging_group_agents WHERE agent_group_id = ?', id)
    ).changes;
    counts.agent_group_members = (await db.run('DELETE FROM agent_group_members WHERE agent_group_id = ?', id)).changes;
    counts.user_roles = (await db.run('DELETE FROM user_roles WHERE agent_group_id = ?', id)).changes;
    // migration-014 has ON DELETE CASCADE on container_configs.agent_group_id;
    // the explicit delete here mirrors the other tables and surfaces the count.
    counts.container_configs = (await db.run('DELETE FROM container_configs WHERE agent_group_id = ?', id)).changes;
    await db.run('DELETE FROM agent_groups WHERE id = ?', id);
    return counts;
  });
}
