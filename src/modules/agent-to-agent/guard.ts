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
 * workers.spawn — creating a worker never requires admin approval, for any
 * cli_scope. The containment that replaces the hold is the operator
 * allowlist: `resolveRepo` (../../worktree.js) resolves `repo` only against
 * `NANOCLAW_PROJECT_ROOTS` (default empty, src/config.ts), and an
 * unresolvable name throws rather than falling back to the group folder. A
 * worker can therefore only ever stand in a repository the operator named, no
 * matter which agent group asked. The entry stays in the catalog purely so the
 * decision stays auditable; it carries no `grantActionName` because it never
 * holds, and `src/guard/conformance.test.ts` requires a registered approval
 * handler for every action that has one. Restoring a hold later means putting
 * `grantActionName` back AND registering a handler for it (./index.js) — not a
 * one-line change, but still a small, localized one.
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

export const workersSpawn = defineGuardedAction({
  action: 'workers.spawn',
  // No grantActionName: this decision never holds, so there is no grant to
  // bind and no approval handler to pair it with — see the file header, and
  // src/guard/conformance.test.ts, which enforces exactly that pairing.
  decide: async (input) => {
    if (input.actor.kind !== 'agent') return DENY('spawn_worker is a container-originated action.');
    // Creating a worker never requires admin approval, for any cli_scope: the
    // operator allowlist (NANOCLAW_PROJECT_ROOTS, resolved by resolveRepo) is
    // the containment, not this decision.
    return ALLOW('spawn_worker requires no approval — repo is bounded by the operator allowlist');
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
