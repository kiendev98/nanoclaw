/**
 * Three keys, not one.
 *
 * The AGENT GROUP is per (principal, repository). It carries the worker's
 * memory and its transcripts, so one shared across principals would hand one
 * assistant's work to another whose approver never saw it. Within a principal,
 * memory of that repository is still shared across every thread that asks.
 * The SESSION is per (worker agent group, messaging group, thread) — the A4
 * reuse key, and the A5 separation key. The WORKTREE is per session, because
 * two threads working one repository at once must not share a working copy.
 *
 * Keying the session on the thread rather than on the principal's session id is
 * deliberate: `session_mode` decides how a thread maps to a principal session,
 * and this key has to mean the same thing under all three modes.
 */
import crypto from 'crypto';

import { createAgentGroup, getAgentGroupByFolder } from '../../../db/agent-groups.js';
import { getContainerConfig } from '../../../db/container-configs.js';
import { isUniqueViolation } from '../../../db/errors.js';
import { groupFolderExistsOnDisk } from '../../../group-folder.js';
import { initGroupFilesystem } from '../../../group-init.js';
import { log } from '../../../log.js';
import { resolveSystemSession } from '../../../session-manager.js';
import type { AgentGroup, Session } from '../../../types.js';
import { createHelper, getHelperForPrincipal } from '../db/worker-helpers.js';
import { firstFreeName } from '../free-name.js';
import { generateId } from '../ids.js';
import { createWorkerSession, findWorkerSession, threadKey } from '../db/worker-sessions.js';
import type { ResolvedRepo } from './repo-registry.js';
import { ensureWorktree } from './worktree.js';
import type { WorkerHelper, WorkerSession } from '../types.js';

/** Bounded, separator-free, and stable across restarts. */
function workerThreadId(repoName: string, messagingGroupId: string, threadId: string | null): string {
  const digest = crypto
    .createHash('sha256')
    .update([repoName, messagingGroupId, threadKey(threadId)].join('\0'))
    .digest('hex');
  return `system:worker:${digest.slice(0, 16)}`;
}

/** A folder name nothing else claims, on disk or in the DB. */
async function freeFolderName(preferred: string): Promise<string> {
  return firstFreeName(
    preferred,
    async (candidate) => Boolean(await getAgentGroupByFolder(candidate)) || groupFolderExistsOnDisk(candidate),
  );
}

/**
 * The agent group this principal uses to work this repository, created on first
 * use.
 *
 * One per (principal, repository), not one per repository. The group holds the
 * worker's memory and its transcripts, so a group shared between principals
 * would hand one assistant's work to another whose approver never saw it.
 *
 * A concurrent first delegation loses the UNIQUE race and reads the winner's
 * row, so a principal never ends up with two workers on one repository.
 */
export async function ensureHelperAgentGroup(
  principalAgentGroupId: string,
  repo: ResolvedRepo,
  providerHint: string | null,
): Promise<WorkerHelper> {
  const existing = await getHelperForPrincipal(principalAgentGroupId, repo.name);
  if (existing) return existing;

  const folder = await freeFolderName(`worker-${repo.name}`);
  const group: AgentGroup = {
    id: generateId('ag'),
    name: `${repo.name} worker`,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  };
  const helper: WorkerHelper = {
    helper_agent_group_id: group.id,
    principal_agent_group_id: principalAgentGroupId,
    repo_name: repo.name,
    repo_path: repo.hostPath,
    created_at: group.created_at,
  };

  await createAgentGroup(group);
  try {
    await createHelper(helper);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await getHelperForPrincipal(principalAgentGroupId, repo.name);
    if (!winner) throw error;
    return winner;
  }

  // A helper inherits its principal's provider, never the instance default, so
  // it is never spawned on a runtime the principal cannot reach.
  await initGroupFilesystem(group, { instructions: helperInstructions(repo.name), provider: providerHint });
  log.info('Worker helper agent group created', { repoName: repo.name, agentGroupId: group.id, folder });
  return helper;
}

function helperInstructions(repoName: string): string {
  return [
    `You are the worker for the \`${repoName}\` repository.`,
    '',
    'You work inside a git worktree of that repository, and its own instructions,',
    'skills and conventions are the ones that apply. You have no chat audience:',
    'the only ways back to the assistant that gave you a task are the worker',
    'tools, and each carries one meaning. Read `worker.instructions.md`.',
  ].join('\n');
}

export interface HelperSessionResult {
  workerSession: WorkerSession;
  session: Session;
  created: boolean;
}

/**
 * The helper session for this conversation, created with its worktree on first
 * use and reused afterwards (A4).
 */
export async function ensureHelperSession(
  helper: WorkerHelper,
  conversation: { messagingGroupId: string; threadId: string | null },
): Promise<HelperSessionResult> {
  const { messagingGroupId, threadId } = conversation;
  const { session } = await resolveSystemSession(
    helper.helper_agent_group_id,
    workerThreadId(helper.repo_name, messagingGroupId, threadId),
    'worker',
  );

  const existing = await findWorkerSession(helper.helper_agent_group_id, messagingGroupId, threadId);
  if (existing) return { workerSession: existing, session, created: false };

  const worktree = ensureWorktree(helper.repo_path, helper.repo_name, session.id);
  const row: WorkerSession = {
    helper_session_id: session.id,
    helper_agent_group_id: helper.helper_agent_group_id,
    repo_name: helper.repo_name,
    messaging_group_id: messagingGroupId,
    thread_id: threadKey(threadId),
    worktree_path: worktree.worktreePath,
    branch_name: worktree.branchName,
    created_at: new Date().toISOString(),
  };

  try {
    await createWorkerSession(row);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await findWorkerSession(helper.helper_agent_group_id, messagingGroupId, threadId);
    if (!winner) throw error;
    return { workerSession: winner, session, created: false };
  }
  return { workerSession: row, session, created: true };
}

/** The provider a helper should inherit from the agent group that delegated to it. */
export async function providerOf(agentGroupId: string): Promise<string | null> {
  return (await getContainerConfig(agentGroupId))?.provider ?? null;
}
