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
 *
 * THIS TOOL MINTS COMPANIONS, NOT WORKERS. A companion is long-lived and
 * belongs to its creator; it has no repository, no worktree and no
 * originating conversation. Delegating work INTO a repository is
 * `create_worker` (./create-worker.ts), which owns repo resolution, the
 * worktree, `workspace_path`, the (repo, thread) reuse key, and delivering
 * the brief. Keeping the two apart is the point: `create_agent` is
 * fire-and-forget and hands back no usable handle, which is the wrong shape
 * for a delegation whose answer someone is waiting for.
 *
 * The provisioning body itself is shared — see ./provision-agent.ts.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { requestApproval } from '../approvals/index.js';
import { provisionAgentGroup } from './provision-agent.js';

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
  return true;
}

/** Guard hold: card the requesting group's admin chain. */
export async function requestCreateAgentHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = typeof content.name === 'string' ? content.name : '';
  const instructions = typeof content.instructions === 'string' ? content.instructions : null;
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!sourceGroup) return;

  await requestApproval({
    session,
    agentName: sourceGroup.name,
    action: 'create_agent',
    payload: { name, instructions },
    title: `Create agent: ${name}`,
    question:
      `Agent "${sourceGroup.name}" wants to create a new agent "${name}" ` +
      `(a new agent group with its own workspace and container). Approve?`,
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

  const outcome = await provisionAgentGroup({
    name,
    instructions,
    sourceGroup,
    session,
    // A companion never stands in a repository. `create_worker` is the only
    // caller that passes a worktree.
    workspacePath: null,
  });

  if (!outcome.ok) {
    await notifyAgent(session, `Cannot create agent "${name}": ${outcome.error}.`);
    return;
  }
  if (!options?.suppressCreatedNotify) {
    await notifyAgent(
      session,
      `Agent "${outcome.localName}" created. You can now message it with ` +
        `send_message({ to: "${outcome.localName}", ... }).`,
    );
  }
}
