/**
 * Agent-to-agent module — inter-agent messaging and on-demand agent creation.
 *
 * Registers its guard-catalog entries (./guard.js) and two guard-wrapped
 * delivery actions (`create_agent`, `spawn_worker`) — both write central-DB
 * state. `create_agent`'s agents.create decision holds confined (non-global)
 * groups for admin approval while trusted global-scope groups create
 * directly, and its approval handler re-enters the wrapped action carrying
 * the approval row as its grant. `spawn_worker`'s workers.spawn decision
 * ALLOWs unconditionally for every agent actor — a worker is contained by the
 * operator's repo allowlist, not by an approval gate, so it has no approval
 * handler to re-enter. The sibling `channel_type === 'agent'` routing path is
 * NOT a system action — core `delivery.ts` dispatches into `./agent-route.js`
 * via a dynamic import when it sees `msg.channel_type === 'agent'`.
 *
 * Host integration points:
 *   - `src/container-runner.ts::spawnContainer` dynamically imports
 *     `./write-destinations.js` on every wake (guarded by `hasTable('agent_destinations')`).
 *   - `src/delivery.ts::deliverMessage` dynamically imports `./agent-route.js`
 *     when `msg.channel_type === 'agent'`.
 *
 * Without this module: `agent_destinations` table absent ⇒ container-runner
 * skips destination projection, ACL check in delivery skips, the
 * `create_agent` and `spawn_worker` system actions log "Unknown system
 * action", `channel_type='agent'` messages throw because the module isn't
 * installed.
 */
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { A2A_MESSAGE_GATE_ACTION } from './agent-route.js';
import { createAgent, requestCreateAgentHold, validateCreateAgent } from './create-agent.js';
import { spawnWorker, denySpawnWorker, validateSpawnWorker } from './spawn-worker.js';
import { agentsCreate, workersSpawn } from './guard.js';
import { applyA2aMessageGate } from './message-gate.js';

registerDeliveryAction('create_agent', createAgent, {
  guardAction: agentsCreate,
  precheck: validateCreateAgent,
  requestHold: requestCreateAgentHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `create_agent denied: ${reason}`),
});
registerApprovalHandler('create_agent', reenterGuardedDeliveryAction('create_agent'));

// `spawn_worker` is a SEPARATE action, not a flavour of create_agent, and the
// distinct name is load-bearing beyond tidiness: `slack-agent-flow` registers
// OVER the `create_agent` delivery action and matches on
// `action === 'create_agent'` to provision a Slack bot, a DM and a room. A
// worker routed through that name would be provisioned as a Slack persona.
//
// No requestHold and no approval handler: workers.spawn never holds (see
// ./guard.ts), so there is no approved replay to re-enter this action for.
registerDeliveryAction('spawn_worker', spawnWorker, {
  guardAction: workersSpawn,
  precheck: validateSpawnWorker,
  onDeny: denySpawnWorker,
});

// The pre-rename name, kept as an alias for one release.
//
// The host and the runner update independently — even under the local driver,
// where a `git pull` gives the running host process old code while the next
// spawn reads the new runner off disk. That window has a bad failure: the
// runner writes `action: 'create_worker'`, the host logs "Unknown system
// action" and never answers, so the container's blocking tool polls out its
// full wait and then reports the worker "is still being created … you will be
// woken when it exists". A false success for a worker that will never exist.
//
// Same guard, same precheck, same handler — only the name differs.
registerDeliveryAction('create_worker', spawnWorker, {
  guardAction: workersSpawn,
  precheck: validateSpawnWorker,
  onDeny: denySpawnWorker,
});

registerApprovalHandler(A2A_MESSAGE_GATE_ACTION, applyA2aMessageGate);
