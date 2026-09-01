/**
 * Agent-to-agent guard adapter — the module's catalog entries, composed at
 * the module edge (imported by ./index.ts).
 *
 * agents.create — the cli_scope branch moved verbatim out of
 * create-agent.ts: `global` scope creates directly (create_agent is the
 * intended primitive for trusted owner agent groups); anything else — the
 * default `group` scope, and unknown/missing config, fail-closed — holds for
 * the requesting group's admin chain.
 *
 * workers.create — the same trust split as agents.create, defined
 * separately because a grant is bound to the pending_approvals row's action
 * name and the two hold through different approval handlers. It binds on the
 * REQUEST ID rather than the name: `create_worker` answers a blocking tool by
 * requestId, and a grant bound to a name would let one approval satisfy a
 * different request that happened to ask for the same worker name.
 *
 * a2a.send — the decision moved verbatim out of routeAgentMessage, in its
 * original check order: a missing destination row denies; a missing target
 * group denies; self-sends allow without a destination row; an
 * agent_message_policies row for the (from, to) pair holds for the row's
 * named approver. The ghost-policy edge (policy row with no destination row)
 * denies — the destination check precedes the policy check, exactly today's
 * outcome. Policy rows can only tighten (hold), never allow: absence of a
 * row falls through to the structural checks.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { ALLOW, DENY, HOLD, defineGuardedAction } from '../../guard/index.js';
import { hasDestination } from './db/agent-destinations.js';
import { getMessagePolicy } from './db/agent-message-policies.js';

/**
 * pending_approvals action string for held a2a messages. Lives here (not in
 * agent-route.ts) so agent-route can import this adapter — loading the
 * consult site guarantees its catalog entry is registered — without a cycle.
 */
export const A2A_MESSAGE_GATE_ACTION = 'a2a_message_gate';

export const agentsCreate = defineGuardedAction({
  action: 'agents.create',
  grantActionName: 'create_agent',
  // Bind a create_agent grant to the name that was approved.
  grantCoversRequest: (grant, input) => {
    try {
      return (JSON.parse(grant.payload) as { name?: string }).name === input.payload.name;
    } catch {
      return false;
    }
  },
  decide: async (input) => {
    if (input.actor.kind !== 'agent') return DENY('create_agent is a container-originated action.');
    const cliScope = (await getContainerConfig(input.actor.agentGroupId))?.cli_scope ?? 'group';
    if (cliScope === 'global') {
      // Trusted owner agent group — an approval tap on every sub-agent spawn
      // would be needless friction.
      return ALLOW('trusted global-scope agent group');
    }
    // The realistic prompt-injection victim (default `group` scope) — and any
    // unknown config value, fail-closed — requires an admin before any
    // central-DB write.
    return HOLD('agent-initiated create_agent requires admin approval');
  },
});

export const workersCreate = defineGuardedAction({
  action: 'workers.create',
  grantActionName: 'create_worker',
  grantCoversRequest: (grant, input) => {
    try {
      return (JSON.parse(grant.payload) as { requestId?: string }).requestId === input.payload.requestId;
    } catch {
      return false;
    }
  },
  decide: async (input) => {
    if (input.actor.kind !== 'agent') return DENY('create_worker is a container-originated action.');
    const cliScope = (await getContainerConfig(input.actor.agentGroupId))?.cli_scope ?? 'group';
    // A worker is a privileged central-DB write plus a git worktree of a real
    // repository on the host, so it holds wherever create_agent holds: a
    // trusted owner group acts directly, and the realistic prompt-injection
    // victim (the default `group` scope, and any unknown value, fail-closed)
    // needs an admin first.
    if (cliScope === 'global') return ALLOW('trusted global-scope agent group');
    return HOLD('agent-initiated create_worker requires admin approval');
  },
});

export const a2aSend = defineGuardedAction({
  action: 'a2a.send',
  grantActionName: A2A_MESSAGE_GATE_ACTION,
  // Bind an a2a grant to the exact held message target.
  grantCoversRequest: (grant, input) => {
    try {
      return (JSON.parse(grant.payload) as { platform_id?: string }).platform_id === input.resource?.to;
    } catch {
      return false;
    }
  },
  decide: async (input) => {
    if (input.actor.kind !== 'agent') return DENY('agent-to-agent send requires an agent actor');
    const from = input.actor.agentGroupId;
    const to = input.resource?.to ?? '';
    const isSelf = to === from;
    if (!isSelf && !(await hasDestination(from, 'agent', to))) {
      return DENY(`unauthorized agent-to-agent: ${from} has no destination for ${to}`);
    }
    if (!(await getAgentGroup(to))) {
      return DENY(`target agent group ${to} not found for message ${String(input.payload.id)}`);
    }
    if (isSelf) return ALLOW('self-send');
    const policy = await getMessagePolicy(from, to);
    if (policy) {
      return HOLD(`a2a message policy ${from}→${to} holds for ${policy.approver}`, policy.approver);
    }
    return ALLOW('destination grant exists');
  },
});
