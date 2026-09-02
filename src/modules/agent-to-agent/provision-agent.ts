/**
 * The body that mints an agent group for `spawn_worker` — a delegate standing
 * in a repository worktree.
 *
 * **It deliberately duplicates the equivalent body inside `create-agent.ts`,
 * and that is a fork decision, not an oversight.** This started as one shared
 * function called by both. Sharing it meant gutting `create-agent.ts` — an
 * upstream file — from 207 lines to 127, which left a 144-line diff to
 * re-resolve on every upstream merge, forever. `create-agent.ts` is now held
 * byte-identical to upstream and this copy serves the worker path alone.
 *
 * The trade: duplication inside a file we own is free at merge time; a diff
 * against a file upstream owns is not. Optimising for line count here would be
 * optimising the wrong number.
 *
 * **What that costs, and what to do about it.** The two copies can drift
 * silently, and every step here is a way to lose data quietly when they do:
 * the folder dedupe that must not adopt deleted-group residue, the traversal
 * check on the derived path, the bidirectional destination rows that are the
 * ACL, and the projection into the requester's running container without which
 * the new name resolves to "dropped: unknown destination". One of those
 * matters specifically to workers: the child's `parent` row is what stops the
 * `a2a.send` guard denying a worker's reply to its orchestrator.
 *
 * So when an upstream sync touches `create-agent.ts`, diff its minting body
 * against this one and decide deliberately whether the change applies here.
 * Nothing enforces it.
 *
 * AUTHORIZATION IS THE CALLER'S RESPONSIBILITY. This performs privileged
 * central-DB writes a confined container is otherwise barred from; it is only
 * ever reached past a guard decision (see ./guard.ts). Nothing in here checks
 * who asked.
 */
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { groupFolderExistsOnDisk } from '../../group-folder.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import type { AgentGroup, Session } from '../../types.js';
import { createDestination, getDestinationByName, normalizeName } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

export interface ProvisionRequest {
  /** Human-readable name; its normalized form becomes the requester's handle. */
  name: string;
  /** Standing role text, written as the new group's `instructions.prepend.md`. */
  instructions: string | null;
  /** The group that asked, which gains a destination row for the new one. */
  sourceGroup: AgentGroup;
  /** The session that asked — the origin of a worker, ignored for a companion. */
  session: Session;
  /**
   * Worktree the new group stands in, or null for an ordinary companion.
   *
   * Non-null is what makes the new group a WORKER, and it decides two other
   * columns: `workspace_path` becomes its cwd, and `origin_session_id` records
   * the conversation it belongs to. A companion gets NULL for both, so no
   * later request in any thread can be handed it as a reused worker.
   */
  workspacePath: string | null;
}

export type ProvisionOutcome = { ok: true; localName: string; agentGroupId: string } | { ok: false; error: string };

/**
 * Create the agent group, scaffold its filesystem, and wire both destination
 * rows.
 *
 * @returns The requester's handle for the new agent, or the agent-facing
 *   reason it could not be created. Never throws for an expected refusal —
 *   the caller reports it, and the two callers report through different
 *   channels.
 */
export async function provisionAgentGroup(req: ProvisionRequest): Promise<ProvisionOutcome> {
  const { name, instructions, sourceGroup, session, workspacePath } = req;
  const localName = normalizeName(name);

  // Collision in the creator's destination namespace
  if (await getDestinationByName(sourceGroup.id, localName)) {
    return { ok: false, error: `you already have a destination named "${localName}"` };
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
    log.error('agent provisioning path traversal attempt', { folder, resolvedPath });
    return { ok: false, error: 'invalid folder path' };
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
  // The child's row for its creator is not decoration. A worker's replies are
  // routed to its orchestrator BY CODE (see writeSessionRouting), and that
  // route passes the `a2a.send` guard, which denies any pair with no
  // destination row. Without this row a worker's answer is denied and dropped.
  //
  // Handle the unlikely case where the child already has a "parent"
  // destination (shouldn't happen for a brand-new agent, but be safe).
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

  log.info('Agent group created', {
    agentGroupId,
    name,
    localName,
    folder,
    parent: sourceGroup.id,
    workspacePath: workspacePath ?? undefined,
  });
  return { ok: true, localName, agentGroupId };
}
