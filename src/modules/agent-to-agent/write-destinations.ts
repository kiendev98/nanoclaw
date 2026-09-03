/**
 * Project the agent's central `agent_destinations` rows into its per-session
 * `inbound.db` so the running container can resolve names locally. Called on
 * every container wake and after admin-time destination edits (e.g. create_agent).
 *
 * Core container-runner calls this via a dynamic import guarded by a
 * `hasTable('agent_destinations')` check — without the agent-to-agent module
 * installed, the central table doesn't exist and the projection is skipped.
 *
 * IT ALSO CARRIES THE THREAD THIS SESSION OPENED. `delivery.ts` binds a
 * session to the thread its first top-level post created, and until now that
 * binding was readable only by the host: it routed a human's reply IN, and the
 * container had no way to learn where to reply OUT. A worker's second post
 * therefore named no thread and opened a SECOND root — which is first-wins, so
 * it never bound, and every reply in it was lost.
 *
 * Rewritten wholesale on every wake, so the value tracks the binding without a
 * second write path or an invalidation rule.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import type { Destination } from '../../mailbox/index.js';
import { log } from '../../log.js';
import { withMailboxSession } from '../../session-manager.js';
import { getDestinations } from './db/agent-destinations.js';

export async function writeDestinations(agentGroupId: string, sessionId: string): Promise<void> {
  const rows = await getDestinations(agentGroupId);
  const resolved: Destination[] = [];

  // The session's own binding, if it has one: (messaging group, root message).
  const session = await getSession(sessionId);
  const boundMg = session?.bound_messaging_group_id ?? null;
  const boundRoot = session?.bound_root_message_id ?? null;

  for (const row of rows) {
    if (row.target_type === 'channel') {
      const mg = await getMessagingGroup(row.target_id);
      if (!mg) continue;
      // COMPOSED, not stored. `bound_root_message_id` is the platform's own
      // root id; a thread address is `<platform_id>:<root>`, which is the form
      // every inbound row and every adapter uses. Composing it here rather
      // than storing a second copy keeps one source of truth — and the
      // composition is only ever used to SEND, never to match an inbound
      // thread, which is the direction `threadRootMessageId` warns about.
      const threadId = boundMg && boundRoot && mg.id === boundMg ? `${mg.platform_id}:${boundRoot}` : null;
      resolved.push({
        name: row.local_name,
        displayName: mg.name ?? row.local_name,
        type: 'channel',
        channelType: mg.channel_type,
        platformId: mg.platform_id,
        agentGroupId: null,
        threadId,
      });
    } else if (row.target_type === 'agent') {
      const ag = await getAgentGroup(row.target_id);
      if (!ag) continue;
      resolved.push({
        name: row.local_name,
        displayName: ag.name,
        type: 'agent',
        channelType: null,
        platformId: null,
        agentGroupId: ag.id,
        // An agent destination is a lane, not a conversation.
        threadId: null,
      });
    }
  }

  await withMailboxSession(agentGroupId, sessionId, (db) => {
    db.replaceDestinations(resolved);
  });
  log.debug('Destination map written', { sessionId, count: resolved.length });
}
