/** `worker_helpers` — the one agent group that works a given repository. */
import { getDb } from '../../../db/connection.js';
import type { WorkerHelper } from '../types.js';

export async function getHelperByRepo(repoName: string): Promise<WorkerHelper | undefined> {
  return getDb().get<WorkerHelper>('SELECT * FROM worker_helpers WHERE repo_name = ?', repoName);
}

export async function getHelperByAgentGroup(agentGroupId: string): Promise<WorkerHelper | undefined> {
  return getDb().get<WorkerHelper>('SELECT * FROM worker_helpers WHERE helper_agent_group_id = ?', agentGroupId);
}

export async function createHelper(helper: WorkerHelper): Promise<void> {
  await getDb().run(
    `INSERT INTO worker_helpers (helper_agent_group_id, repo_name, repo_path, created_at)
       VALUES (@helper_agent_group_id, @repo_name, @repo_path, @created_at)`,
    { ...helper },
  );
}

/** True when this agent group is a helper — the A6 check, in one read. */
export async function isHelperAgentGroup(agentGroupId: string): Promise<boolean> {
  return (await getHelperByAgentGroup(agentGroupId)) !== undefined;
}
