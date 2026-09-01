/**
 * Relay a repo-scoped worker's reply into the conversation that asked for it.
 *
 * A worker has no channel of its own. Its reply travels the ordinary
 * agent-to-agent lane to the orchestrator that created it, and the orchestrator
 * then has to be woken, read it, and repeat it — a whole extra model turn whose
 * only product is a paraphrase, delivered in the ORCHESTRATOR's voice. The human
 * cannot tell which repository answered, or whether they are reading the worker
 * or a summary of it.
 *
 * So the host echoes the worker's own words into the thread, attributed, at the
 * moment it routes them. The orchestrator still receives the message — it is
 * orchestrating and must know — but it no longer has to speak for the worker.
 *
 * ## Why a worker cannot reach an arbitrary thread
 *
 * Three separate bounds, and none of them is a filter on something the worker
 * said:
 *
 * 1. **The destination map.** This runs only from inside `performAgentRoute`,
 *    which is reachable only past the `a2a.send` guard decision — so the worker
 *    must hold an `agent_destinations` row for the orchestrator, and any
 *    `agent_message_policies` hold on that edge still cards an admin first.
 * 2. **The origin column.** The relay fires only when the target session IS the
 *    worker's `origin_session_id`. That column is written once, by
 *    `create_agent`, from the session that asked for the worker. Nothing the
 *    worker sends can change it, so a worker created in thread A can never
 *    relay into thread B — not by naming it, and not by replying to a message
 *    that came from it.
 * 3. **The address.** Channel, platform id and thread id are read from that
 *    session's own row and its messaging group. The worker supplies text and
 *    nothing else; there is no field in an a2a message that can name a
 *    destination address.
 *
 * A failed relay is logged and swallowed. The message is already in the
 * orchestrator's inbound by the time this runs, so the work is not lost — and a
 * throw here would fail the route, retry it, and duplicate the inbound.
 */
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { AgentGroup, Session } from '../../types.js';
import { worktreeRepoName } from '../../worktree.js';

/**
 * True when `sourceGroup` is a repo-scoped worker replying into the very
 * conversation it was created for.
 *
 * Both halves are required. `workspace_path` alone is a worker; both together
 * are a worker talking to its own thread, which is the only thing that earns a
 * channel message.
 */
function isWorkerReplyingHome(sourceGroup: AgentGroup, targetSession: Session): boolean {
  return Boolean(sourceGroup.workspace_path) && sourceGroup.origin_session_id === targetSession.id;
}

/** The text of an a2a payload, which is JSON `{ text, files?… }` or bare text. */
function messageText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return content;
  }
}

/**
 * How a worker's message is labelled in the human's thread.
 *
 * The label names the repository, not just the agent: "Scout said X" leaves the
 * reader guessing which of several repos answered, and an unlabelled message
 * reads as the orchestrator's own conclusion.
 */
function attribute(workerName: string, repoName: string, text: string): string {
  return `*${workerName}* · \`${repoName}\`\n${text}`;
}

/**
 * Echo a worker's reply into its originating thread. No-op for anything that is
 * not a worker replying home.
 *
 * @param sourceGroup The agent group that sent the a2a message.
 * @param targetSession The session the message was routed to.
 * @param content The a2a payload, as stored on the outbound row.
 */
export async function relayWorkerReply(
  sourceGroup: AgentGroup,
  targetSession: Session,
  content: string,
): Promise<void> {
  if (!isWorkerReplyingHome(sourceGroup, targetSession)) return;
  if (!targetSession.messaging_group_id) return; // no human thread to reach

  const text = messageText(content).trim();
  if (!text) return;

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('Worker reply not relayed — no delivery adapter', { worker: sourceGroup.id });
    return;
  }

  const mg = await getMessagingGroup(targetSession.messaging_group_id);
  if (!mg) {
    log.warn('Worker reply not relayed — origin messaging group is gone', {
      worker: sourceGroup.id,
      messagingGroup: targetSession.messaging_group_id,
    });
    return;
  }
  if (mg.detached_at) {
    // The bot was removed from this conversation. Posting would be rejected,
    // and the orchestrator already holds the message.
    log.info('Worker reply not relayed — origin channel is detached', { worker: sourceGroup.id, mg: mg.id });
    return;
  }

  const repoName = worktreeRepoName(sourceGroup.workspace_path!);
  try {
    await adapter.deliver(
      mg.channel_type,
      mg.platform_id,
      // Read from the session row, never from the message: this is what makes
      // the thread unreachable by anything the worker says.
      targetSession.thread_id,
      'chat',
      JSON.stringify({ text: attribute(sourceGroup.name, repoName, text) }),
      undefined,
      mg.instance,
    );
    log.info('Worker reply relayed to its originating thread', {
      worker: sourceGroup.id,
      repo: repoName,
      session: targetSession.id,
      threadId: targetSession.thread_id,
    });
  } catch (err) {
    // Never rethrow: the orchestrator's inbound copy is already written, and a
    // throw would fail the route, retry it, and duplicate that copy.
    log.error('Worker reply relay failed — the orchestrator still has the message', {
      worker: sourceGroup.id,
      session: targetSession.id,
      err,
    });
  }
}
