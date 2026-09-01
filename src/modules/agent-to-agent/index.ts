/**
 * Agent-to-agent module — inter-agent messaging and on-demand agent creation.
 *
 * Registers its guard-catalog entries (./guard.js) and two guard-wrapped
 * delivery actions (`create_agent`, `create_worker`) — both write central-DB
 * state, so the guard's agents.create / workers.create decisions hold
 * confined (non-global) groups for admin approval while trusted global-scope
 * groups create directly; the approval handler re-enters the wrapped action
 * carrying the approval row as its grant. The sibling `channel_type === 'agent'` routing path is NOT a
 * system action — core `delivery.ts` dispatches into `./agent-route.js` via
 * a dynamic import when it sees `msg.channel_type === 'agent'`.
 *
 * Host integration points:
 *   - `src/container-runner.ts::spawnContainer` dynamically imports
 *     `./write-destinations.js` on every wake (guarded by `hasTable('agent_destinations')`).
 *   - `src/delivery.ts::deliverMessage` dynamically imports `./agent-route.js`
 *     when `msg.channel_type === 'agent'`.
 *
 * Without this module: `agent_destinations` table absent ⇒ container-runner
 * skips destination projection, ACL check in delivery skips, the
 * `create_agent` and `create_worker` system actions log "Unknown system
 * action", `channel_type='agent'` messages throw because the module isn't
 * installed.
 */
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { A2A_MESSAGE_GATE_ACTION } from './agent-route.js';
import { createAgent, requestCreateAgentHold, validateCreateAgent } from './create-agent.js';
import { createWorker, denyCreateWorker, requestCreateWorkerHold, validateCreateWorker } from './create-worker.js';
import { agentsCreate, workersCreate } from './guard.js';
import { applyA2aMessageGate } from './message-gate.js';

registerDeliveryAction('create_agent', createAgent, {
  guardAction: agentsCreate,
  precheck: validateCreateAgent,
  requestHold: requestCreateAgentHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `create_agent denied: ${reason}`),
});
registerApprovalHandler('create_agent', reenterGuardedDeliveryAction('create_agent'));

// `create_worker` is a SEPARATE action, not a flavour of create_agent, and the
// distinct name is load-bearing beyond tidiness: `slack-agent-flow` registers
// OVER the `create_agent` delivery action and matches on
// `action === 'create_agent'` to provision a Slack bot, a DM and a room. A
// worker routed through that name would be provisioned as a Slack persona.
registerDeliveryAction('create_worker', createWorker, {
  guardAction: workersCreate,
  precheck: validateCreateWorker,
  requestHold: requestCreateWorkerHold,
  onDeny: denyCreateWorker,
});
registerApprovalHandler('create_worker', reenterGuardedDeliveryAction('create_worker'));

registerApprovalHandler(A2A_MESSAGE_GATE_ACTION, applyA2aMessageGate);
