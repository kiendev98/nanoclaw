/**
 * Agent-to-agent module — inter-agent messaging and on-demand agent creation.
 *
 * Registers its guard-catalog entry (./guard.js) and one guard-wrapped
 * delivery action (`create_agent`), which writes central-DB state.
 * `create_agent`'s agents.create decision holds confined (non-global) groups
 * for admin approval while trusted global-scope groups create directly, and
 * its approval handler re-enters the wrapped action carrying the approval row
 * as its grant. The sibling `channel_type === 'agent'` routing path is NOT a
 * system action — core `delivery.ts` dispatches into `./agent-route.js` via a
 * dynamic import when it sees `msg.channel_type === 'agent'`.
 *
 * Host integration points:
 *   - `src/container-runner.ts::spawnContainer` dynamically imports
 *     `./write-destinations.js` on every wake (guarded by `hasTable('agent_destinations')`).
 *   - `src/delivery.ts::deliverMessage` dynamically imports `./agent-route.js`
 *     when `msg.channel_type === 'agent'`.
 *
 * Without this module: `agent_destinations` table absent ⇒ container-runner
 * skips destination projection, ACL check in delivery skips, the
 * `create_agent` system action logs "Unknown system action",
 * `channel_type='agent'` messages throw because the module isn't installed.
 */
import { parseBoundedRequest, respondAndWake, wakeRequester } from '../../bounded-request.js';
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import type { Session } from '../../types.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { A2A_MESSAGE_GATE_ACTION } from './agent-route.js';
import { createAgent, requestCreateAgentHold, validateCreateAgent } from './create-agent.js';
import { agentsCreate } from './guard.js';
import { applyA2aMessageGate } from './message-gate.js';

registerDeliveryAction('create_agent', createAgent, {
  guardAction: agentsCreate,
  precheck: validateCreateAgent,
  requestHold: requestCreateAgentHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `create_agent denied: ${reason}`),
});
registerApprovalHandler('create_agent', reenterGuardedDeliveryAction('create_agent'));

registerApprovalHandler(A2A_MESSAGE_GATE_ACTION, applyA2aMessageGate);

/**
 * Compatibility responder for the deleted `spawn_worker` and `create_worker`
 * container tools — task-scoped workspaces replaced them; see `run_task`
 * (`src/modules/scheduling/run-task.ts`). A warm, pre-upgrade container can
 * still call either. With no handler registered, the action falls through to
 * "Unknown system action" and is silently dropped — the blocking tool that
 * asked then times out and reports a FABRICATED success, because it has no
 * way to tell silence apart from having actually done the work. This answers
 * instead, with an error that tells the caller what to use now.
 */
async function respondRemoved(content: Record<string, unknown>, session: Session, toolName: string): Promise<void> {
  const bounded = parseBoundedRequest(content);
  const message = `${toolName} was removed. Use run_task instead — it creates or reuses the same workspace and queues the run in one call.`;
  await respondAndWake(session, bounded, {
    kind: toolName,
    body: { type: `${toolName}_response`, status: 'error', result: { error: message } },
    wakeText: message,
  });
  // respondAndWake only wakes when a requestId is present (see its own
  // three-mode table); an old container's payload may carry none at all, and
  // an error must still reach it rather than vanish the way the fall-through
  // to "Unknown system action" would have.
  if (!bounded.requestId) await wakeRequester(session, message);
}

for (const toolName of ['spawn_worker', 'create_worker']) {
  registerDeliveryAction(
    toolName,
    (content, session) => respondRemoved(content, session, toolName),
    unguarded('answers with an error only; the tool it responds to no longer exists and does no work'),
  );
}
