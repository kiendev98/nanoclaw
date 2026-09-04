/**
 * `worker_helpers` — the agent group one principal uses to work one repository.
 *
 * Keyed on the principal as well as the repository. A worker's agent group
 * carries its memory and its transcripts, so a group shared between principals
 * would hand one assistant's work to another whose approver never saw it.
 */
import { getDb } from '../../../db/connection.js';
import type { WorkerHelper } from '../types.js';

export async function getHelperForPrincipal(
  principalAgentGroupId: string,
  repoName: string,
): Promise<WorkerHelper | undefined> {
  return getDb().get<WorkerHelper>(
    'SELECT * FROM worker_helpers WHERE principal_agent_group_id = ? AND repo_name = ?',
    principalAgentGroupId,
    repoName,
  );
}

export async function getHelperByAgentGroup(agentGroupId: string): Promise<WorkerHelper | undefined> {
  return getDb().get<WorkerHelper>('SELECT * FROM worker_helpers WHERE helper_agent_group_id = ?', agentGroupId);
}

export async function createHelper(helper: WorkerHelper): Promise<void> {
  await getDb().run(
    `INSERT INTO worker_helpers (
        helper_agent_group_id, principal_agent_group_id, repo_name, repo_path, created_at
      ) VALUES (
        @helper_agent_group_id, @principal_agent_group_id, @repo_name, @repo_path, @created_at
      )`,
    { ...helper },
  );
}

/** True when this agent group is a worker — the A6 check, in one read. */
export async function isHelperAgentGroup(agentGroupId: string): Promise<boolean> {
  return (await getHelperByAgentGroup(agentGroupId)) !== undefined;
}
