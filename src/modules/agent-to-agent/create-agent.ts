/**
 * `create_agent` delivery-action bodies.
 *
 * SECURITY: `create_agent` writes to the CENTRAL DB (agent_groups,
 * container_configs, agent_destinations) and scaffolds host filesystem state —
 * a privileged operation a confined container is otherwise architecturally
 * barred from. The container's MCP tool gate is inside the (untrusted)
 * container and is trivially bypassed by writing the outbound system row
 * directly, so authorization MUST be enforced host-side: the delivery
 * registry wraps this action with the guard, whose `agents.create` decision
 * (./guard.ts) is the old cli_scope branch verbatim — trusted global-scope
 * groups allow, everything else (including unknown config, fail-closed)
 * holds for admin approval. On approve the continuation re-enters the
 * wrapped action with the approval row as its grant and `createAgent` runs.
 * `performCreateAgent` is the module-private body.
 *
 * The optional `repo` argument raises the stakes rather than adding a feature:
 * it decides the new agent's WORKING directory, and cwd is the only thing that
 * decides which repository's `CLAUDE.md`, `.claude/skills/` and
 * `.claude/settings.json` that agent loads. It arrives from the same untrusted
 * container as everything else here, so it is never treated as a path — it is a
 * NAME resolved against the operator's `NANOCLAW_PROJECT_ROOTS` allowlist
 * (empty by default), and an unresolvable name aborts the creation loudly. It
 * must never fall back to the group folder: a worker in the wrong repository is
 * indistinguishable from a working one until it edits the wrong tree.
 *
 * A worker is the pair (repository, originating thread), NOT one agent per
 * command. A second `create_agent({ repo })` in the same thread returns the
 * first worker; see `worker-identity.ts` for why the branch is derived from the
 * origin session, and `existingWorkerFor` for the lookup.
 */
import path from 'path';

import { GROUPS_DIR, PROJECT_ROOTS } from '../../config.js';
import { createAgentGroup, findWorkerForOrigin, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { groupFolderExistsOnDisk } from '../../group-folder.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import { requestApproval } from '../approvals/index.js';
import { createWorktree, resolveRepo } from '../../worktree.js';
import {
  createDestination,
  getDestinationByName,
  getDestinationByTarget,
  normalizeName,
} from './db/agent-destinations.js';
import { workerBranch, workerWorkspace } from './worker-identity.js';
import { writeDestinations } from './write-destinations.js';

/** The optional `repo` argument, as the container sent it. */
function requestedRepo(content: Record<string, unknown>): string {
  return typeof content.repo === 'string' ? content.repo.trim() : '';
}

/**
 * The worker this (repo, thread) pair already has, or undefined.
 *
 * ONE worker per (repository, originating thread), not one per command. A
 * second `create_agent({ repo })` in the same thread must come back with the
 * FIRST worker: a fresh one would stand on a fresh branch in a fresh worktree
 * and could not see a line of the work already done there, so the thread would
 * hold two agents giving divergent answers about the same repository with
 * nothing to say which was current.
 *
 * The key is `(origin_session_id, workspace_path)`, and it is a genuine pair
 * rather than a redundant one: `workspace_path` is a pure function of (repo,
 * origin session), so one thread can hold one worker per repository, while the
 * same repository in another thread is a different worker.
 *
 * @throws Never — an unresolvable repo is the caller's error to report.
 */
async function existingWorkerFor(repoPath: string, originSessionId: string): Promise<AgentGroup | undefined> {
  return findWorkerForOrigin(originSessionId, workerWorkspace(repoPath, originSessionId));
}

/**
 * What the requester should be told to do with a worker that already exists.
 *
 * The local name matters more than the group id: it is the only handle
 * `send_message` accepts. A worker with no destination row in the requester's
 * namespace is unreachable, so that case falls through to a fresh creation
 * rather than handing back a name that does not resolve.
 */
async function reusableWorkerName(sourceGroupId: string, worker: AgentGroup): Promise<string | undefined> {
  return (await getDestinationByTarget(sourceGroupId, 'agent', worker.id))?.local_name;
}

async function notifyAgent(session: Session, text: string): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = await getSession(session.id);
  if (fresh) await requestWake(fresh, 'agent-created');
}

/** Guard precheck: malformed requests are answered without ever creating a hold. */
export async function validateCreateAgent(content: Record<string, unknown>, session: Session): Promise<boolean> {
  const name = typeof content.name === 'string' ? content.name : '';
  if (!name) {
    await notifyAgent(session, 'create_agent failed: name is required.');
    return false;
  }
  if (!(await getAgentGroup(session.agent_group_id))) {
    await notifyAgent(session, 'create_agent failed: source agent group not found.');
    log.warn('create_agent failed: missing source group', { sessionAgentGroup: session.agent_group_id, name });
    return false;
  }

  // Resolve the repo BEFORE any hold is created. An unresolvable repo is a
  // malformed request, and carding an admin for a request that cannot succeed
  // wastes the one human in the loop. Failure is loud and terminal: there is no
  // fallback to the group folder, because a worker silently created in the
  // wrong directory looks exactly like one created in the right one.
  const repo = requestedRepo(content);
  if (repo) {
    let repoPath: string;
    try {
      repoPath = resolveRepo(repo, PROJECT_ROOTS);
    } catch (err) {
      await notifyAgent(session, `create_agent failed: ${err instanceof Error ? err.message : String(err)}`);
      log.warn('create_agent failed: repo not resolvable', { name, repo, err });
      return false;
    }

    // Reuse is decided BEFORE the hold, for the same reason resolution is:
    // this request needs no new privilege — the worker, its worktree and the
    // destination row all exist already — so carding an admin spends the one
    // human in the loop on a question with no consequences either way.
    const existing = await existingWorkerFor(repoPath, session.id);
    if (existing) {
      const localName = await reusableWorkerName(session.agent_group_id, existing);
      if (localName) {
        await notifyAgent(
          session,
          `Agent "${localName}" is already working in "${repo}" for this conversation — reuse it with ` +
            `send_message({ to: "${localName}", ... }). A second agent would stand on a second branch and ` +
            `could not see the work "${localName}" has already done.`,
        );
        log.info('create_agent reused an existing worker', {
          name,
          repo,
          localName,
          worker: existing.id,
          originSession: session.id,
        });
        return false;
      }
      // The worker exists but this requester cannot address it. Falling
      // through creates a reachable one rather than naming a handle that does
      // not resolve.
      log.warn('create_agent: worker exists for this thread but the requester has no destination for it', {
        repo,
        worker: existing.id,
        originSession: session.id,
      });
    }
  }
  return true;
}

/** Guard hold: card the requesting group's admin chain. */
export async function requestCreateAgentHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = typeof content.name === 'string' ? content.name : '';
  const instructions = typeof content.instructions === 'string' ? content.instructions : null;
  const repo = requestedRepo(content);
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!sourceGroup) return;

  await requestApproval({
    session,
    agentName: sourceGroup.name,
    action: 'create_agent',
    payload: { name, instructions, repo: repo || null },
    title: `Create agent: ${name}`,
    // The repo is named in the question, not just carried in the payload: it is
    // the part of this request an admin most needs to see. The payload carries
    // it because an approved replay re-enters the action with the APPROVAL ROW
    // as its content — a repo left out here would be dropped on approval, and
    // the worker would come back scoped to nothing.
    question:
      `Agent "${sourceGroup.name}" wants to create a new sub-agent "${name}" ` +
      `(a new agent group with its own workspace and container)` +
      `${repo ? `, working in the repository "${repo}"` : ''}. Approve?`,
  });
}

export interface CreateAgentOptions {
  /**
   * Suppress the terminal `Agent "<name>" created…` success notify. Error
   * notifies (collision, invalid path) still fire. For wrappers whose own
   * completion text is the requester's only "done" signal — e.g.
   * slack-agent-flow, where Slack provisioning runs AFTER this returns and
   * relaying the upstream text would report "done" ~a minute early.
   */
  suppressCreatedNotify?: boolean;
}

/** Guard allow body: performs the creation (fresh global-scope call or approved replay). */
export async function createAgent(
  content: Record<string, unknown>,
  session: Session,
  options?: CreateAgentOptions,
): Promise<void> {
  const name = typeof content.name === 'string' ? content.name : '';
  const instructions = typeof content.instructions === 'string' ? content.instructions : null;
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!name || !sourceGroup) return; // precheck already answered the requester

  await performCreateAgent(
    name,
    instructions,
    requestedRepo(content),
    session,
    sourceGroup,
    (text) => notifyAgent(session, text),
    options,
  );
}

/**
 * Core creation: writes the new agent group + bidirectional destinations and
 * scaffolds its filesystem, then reports via `notify`. Authorization is the
 * CALLER's responsibility (the guard's agents.create decision) — never call
 * this from an unauthorized path, as it performs privileged central-DB
 * writes a confined container is
 * otherwise barred from.
 */
async function performCreateAgent(
  name: string,
  instructions: string | null,
  /** Repo NAME as requested, relative to a PROJECT_ROOTS entry. '' = no repo. */
  repo: string,
  session: Session,
  sourceGroup: AgentGroup,
  notify: (text: string) => Promise<void>,
  options?: CreateAgentOptions,
): Promise<void> {
  // Reuse, re-checked here and not merely in the precheck. An approval can sit
  // for hours, and the same thread may have been given a worker for this repo
  // in the meantime — by another `create_agent` that was approved first, or by
  // this same card being approved twice. Creating anyway would put a second
  // agent on a second branch of the same repository in one conversation, which
  // is the exact failure this whole key exists to prevent.
  //
  // Ordered ahead of the name-collision check on purpose: a repeat request
  // usually carries the same name, and "you already have a destination named
  // X" describes the symptom while hiding the cause.
  if (repo) {
    let existing: AgentGroup | undefined;
    try {
      existing = await existingWorkerFor(resolveRepo(repo, PROJECT_ROOTS), session.id);
    } catch (err) {
      await notify(
        `Cannot create agent "${name}" for repo "${repo}": ${err instanceof Error ? err.message : String(err)}`,
      );
      log.error('create_agent failed: repo no longer resolvable', { name, repo, err });
      return;
    }
    const reuseName = existing && (await reusableWorkerName(sourceGroup.id, existing));
    if (existing && reuseName) {
      await notify(
        `Agent "${reuseName}" is already working in "${repo}" for this conversation — reuse it with ` +
          `send_message({ to: "${reuseName}", ... }).`,
      );
      log.info('create_agent reused an existing worker', {
        name,
        repo,
        localName: reuseName,
        worker: existing.id,
        originSession: session.id,
      });
      return;
    }
  }

  const localName = normalizeName(name);

  // Collision in the creator's destination namespace
  if (await getDestinationByName(sourceGroup.id, localName)) {
    await notify(`Cannot create agent "${name}": you already have a destination named "${localName}".`);
    return;
  }

  // Derive a safe folder name, deduplicated globally across
  // agent_groups.folder AND the on-disk groups/ dir: a folder present on disk
  // with no claiming DB row is deleted-group residue, and adopting it would
  // silently re-scope the old group's data under the new agent's identity —
  // skip to the next suffix instead (templates/create-agent.ts precedent).
  let folder = localName;
  let suffix = 2;
  while ((await getAgentGroupByFolder(folder)) || groupFolderExistsOnDisk(folder)) {
    folder = `${localName}-${suffix}`;
    suffix++;
  }

  const groupPath = path.join(GROUPS_DIR, folder);
  const resolvedPath = path.resolve(groupPath);
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
    await notify(`Cannot create agent "${name}": invalid folder path.`);
    log.error('create_agent path traversal attempt', { folder, resolvedPath });
    return;
  }

  // A repo-scoped worker gets a git worktree, and that worktree becomes its
  // cwd — which is the ONLY thing that makes it load that repository's
  // CLAUDE.md, `.claude/skills/` and `.claude/settings.json`. Resolved again
  // here rather than carried from the precheck: an approval can sit for hours,
  // and the allowlist or the repository may have moved in between.
  //
  // Any failure aborts the creation. Falling back to the group folder would
  // produce a worker that answers confidently from the wrong directory, which
  // is indistinguishable from a working one until it edits the wrong tree.
  let workspacePath: string | null = null;
  if (repo) {
    try {
      // The branch is derived from the ORIGIN SESSION, not from this agent's
      // folder: it is the (repo, thread) pair that owns a branch, and a
      // folder-derived branch is what let a second worker exist beside the
      // first. `createWorktree` is idempotent on the resulting path, so a
      // retry adopts the worktree rather than duplicating it.
      workspacePath = createWorktree(resolveRepo(repo, PROJECT_ROOTS), workerBranch(session.id));
    } catch (err) {
      await notify(
        `Cannot create agent "${name}" for repo "${repo}": ${err instanceof Error ? err.message : String(err)}`,
      );
      log.error('create_agent failed: could not prepare the repo worktree', { name, repo, folder, err });
      return;
    }
  }

  const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const newGroup: AgentGroup = {
    id: agentGroupId,
    name,
    folder,
    agent_provider: null,
    created_at: now,
    workspace_path: workspacePath,
    // Only a repo-scoped worker belongs to a conversation. An ordinary
    // sub-agent is the creator's, not the thread's, and NULL here means no
    // later `create_agent` in any thread can be handed it as a reused worker.
    origin_session_id: workspacePath ? session.id : null,
  };
  await createAgentGroup(newGroup);
  // Subagent path: a child inherits its creator's EFFECTIVE provider, NOT the
  // instance-wide default — so a child is never spawned on a runtime the parent
  // can't reach (e.g. a codex-only install where claude isn't authenticated).
  // Passing it explicitly to initGroupFilesystem pins the child's scaffold and
  // stamps its config row in one step (a NULL parent resolves to claude). The
  // operator can still flip a child later with `ncl groups config update
  // --provider`.
  const parentProvider = (await getContainerConfig(sourceGroup.id))?.provider ?? 'claude';
  await initGroupFilesystem(newGroup, { instructions: instructions ?? undefined, provider: parentProvider });

  // Insert bidirectional destination rows (= ACL grants).
  // Creator refers to child by the name it chose; child refers to creator as "parent".
  await createDestination({
    agent_group_id: sourceGroup.id,
    local_name: localName,
    target_type: 'agent',
    target_id: agentGroupId,
    created_at: now,
  });
  // Handle the unlikely case where the child already has a "parent" destination
  // (shouldn't happen for a brand-new agent, but be safe).
  let parentName = 'parent';
  let parentSuffix = 2;
  while (await getDestinationByName(agentGroupId, parentName)) {
    parentName = `parent-${parentSuffix}`;
    parentSuffix++;
  }
  await createDestination({
    agent_group_id: agentGroupId,
    local_name: parentName,
    target_type: 'agent',
    target_id: sourceGroup.id,
    created_at: now,
  });

  // REQUIRED: project the new destination into the running container's
  // inbound.db. See the top-of-file invariant in db/agent-destinations.ts
  // — forgetting this causes "dropped: unknown destination" when the parent
  // tries to send to the newly-created child.
  await writeDestinations(session.agent_group_id, session.id);

  if (!options?.suppressCreatedNotify) {
    await notify(
      `Agent "${localName}" created${workspacePath ? ` in a worktree of "${repo}"` : ''}. ` +
        `You can now message it with send_message({ to: "${localName}", ... }).`,
    );
  }
  log.info('Agent group created', {
    agentGroupId,
    name,
    localName,
    folder,
    parent: sourceGroup.id,
    repo: repo || undefined,
    workspacePath: workspacePath ?? undefined,
  });
}
