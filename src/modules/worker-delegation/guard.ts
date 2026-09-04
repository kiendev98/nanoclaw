/**
 * Worker-delegation guard adapter — the module's catalog entries, composed at
 * the module edge (imported by ./index.ts).
 *
 * Both actions write central-DB state a confined container is otherwise barred
 * from, so both follow `agents.create`'s trust tier: a trusted global-scope
 * group acts directly, anything else — including unknown or missing config,
 * fail-closed — holds for its admin chain.
 *
 * The one addition is checked BEFORE the trust tier, in both actions: a caller
 * that is itself a helper is denied outright. A6 forbids a second level of
 * delegation, and a deny is not something an approval can lift.
 */
import { getContainerConfig } from '../../db/container-configs.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { ALLOW, DENY, HOLD, defineGuardedAction, type GuardInput } from '../../guard/index.js';
import { getDestinationByName } from '../agent-to-agent/db/agent-destinations.js';
import { isHelperAgentGroup } from './db/worker-helpers.js';

export const WORKER_DELEGATE_ACTION = 'worker_delegate';
export const WORKER_LEND_CONVERSATION_ACTION = 'worker_lend_conversation';

/** The shared tail of both decisions: trusted groups act, confined groups ask. */
async function decideByTrustTier(agentGroupId: string, holdReason: string) {
  const cliScope = (await getContainerConfig(agentGroupId))?.cli_scope ?? 'group';
  if (cliScope === 'global') return ALLOW('trusted global-scope agent group');
  return HOLD(holdReason);
}

function payloadString(input: GuardInput, key: string): string {
  const value = input.payload[key];
  return typeof value === 'string' ? value : '';
}

export const workerDelegate = defineGuardedAction({
  action: 'worker.delegate',
  grantActionName: WORKER_DELEGATE_ACTION,
  // Bind the grant to the exact repository and task that were carded.
  grantCoversRequest: (grant, input) => {
    try {
      const held = JSON.parse(grant.payload) as { repository?: string; task?: string };
      return held.repository === payloadString(input, 'repository') && held.task === payloadString(input, 'task');
    } catch {
      return false;
    }
  },
  decide: async (input) => {
    if (input.actor.kind !== 'agent') return DENY('delegate_task is a container-originated action.');
    if (await isHelperAgentGroup(input.actor.agentGroupId)) {
      return DENY('a helper cannot delegate further — one level only');
    }
    return decideByTrustTier(input.actor.agentGroupId, 'agent-initiated delegate_task requires admin approval');
  },
});

export const workerLendConversation = defineGuardedAction({
  action: 'worker.lend_conversation',
  grantActionName: WORKER_LEND_CONVERSATION_ACTION,
  grantCoversRequest: (grant, input) => {
    try {
      const held = JSON.parse(grant.payload) as { destination?: string; repository?: string };
      return (
        held.destination === payloadString(input, 'destination') &&
        held.repository === payloadString(input, 'repository')
      );
    } catch {
      return false;
    }
  },
  decide: async (input) => {
    if (input.actor.kind !== 'agent') return DENY('lend_conversation is a container-originated action.');
    if (await isHelperAgentGroup(input.actor.agentGroupId)) {
      return DENY('a helper cannot lend a conversation — it holds none of its own');
    }
    // D2: only a channel the principal already holds. Resolving the caller's
    // own destination name IS that check — a name it does not hold resolves to
    // nothing, so a forged messaging group cannot be smuggled in the payload.
    const destination = await getDestinationByName(input.actor.agentGroupId, payloadString(input, 'destination'));
    if (!destination || destination.target_type !== 'channel') {
      return DENY('you do not hold that conversation, so it cannot be lent');
    }
    // D11: and one nobody has detached, reusing delivery's own check.
    const messagingGroup = await getMessagingGroup(destination.target_id);
    if (!messagingGroup) return DENY('that conversation no longer exists');
    if (messagingGroup.detached_at) return DENY('that conversation is detached and cannot be lent');
    return decideByTrustTier(input.actor.agentGroupId, 'agent-initiated lend_conversation requires admin approval');
  },
});
