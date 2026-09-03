/**
 * The router's SECOND fan-out pass: a reply reaching the session that opened
 * the thread it was posted in.
 *
 * Split out of router.ts, which had grown past the point where the two passes
 * could be read separately. They are genuinely separate questions:
 * `routeInbound` asks "who is wired to this chat", and this file asks "whose
 * conversation is this thread". The case that needs the second is an agent
 * deliberately NOT wired here — a repo worker granted one channel for one job,
 * which posts, has a thread form around its post, and needs the human's reply
 * in that thread to reach it rather than a brand-new session.
 *
 * `messageIdForAgent` lives here rather than in router.ts, and that is the
 * point of the seam rather than a convenience. Both passes write into
 * `messages_in`, whose `id` is a PRIMARY KEY, so both must namespace ids the
 * same way or a second delivery to one agent group collides instead of
 * duplicating. Keeping the two writers on opposite sides of a file boundary
 * from the function that guarantees it is how that stops being true.
 *
 * The access gate arrives as a PARAMETER rather than being read from module
 * state. This half must not reach back into router.ts for it: that is a cycle,
 * and more importantly the gate is registered by the permissions module at
 * runtime, so a second reader of that variable is a second thing to keep in
 * step with its registration.
 */
import { gateCommand } from './command-gate.js';
import { findSessionBoundToThread, getSession, threadRootMessageId } from './db/index.js';
import { getAgentGroup } from './db/agent-groups.js';
import { log } from './log.js';
import { requestWake } from './request-wake.js';
import { writeOutboundDirect, writeSessionMessage } from './session-manager.js';
import type { InboundEvent } from './channels/adapter.js';
import type { AccessGateFn } from './router.js';
import type { MessagingGroup, Session } from './types.js';

/**
 * The session that opened this thread, if one did — the first half of the
 * second routing pass.
 *
 * The pair below exists because a thread can belong to an agent group this
 * chat's wiring does not mention, and `getMessagingGroupAgents` answers only
 * "who is wired here".
 *
 * ADDITIVE, NEVER A REPLACEMENT. Every wired agent resolves exactly as it did
 * before this existed and is served first; this only ever appends a delivery
 * the old code dropped. That ordering is what makes the feature unable to
 * regress an existing group — there is no path where a wired agent loses a
 * message to a binding.
 *
 * THREAD-SCOPED, NOT CHANNEL-SCOPED. The binding is (messaging group, root
 * message id), so the session hears replies in ITS thread and nothing else
 * said in that channel. Nothing is written to `messaging_group_agents`, so
 * there is no wiring row for an operator to discover later and no cleanup step
 * when the work finishes — the reach dies with the session, which is the
 * property that makes granting a worker a channel safe to do casually.
 *
 * THE BINDING IS THE ENGAGEMENT SIGNAL. A bound session has no `engage_mode`
 * to consult, and it needs none: it opened that thread on purpose, so a reply
 * in it is addressed to it by construction. Same reasoning as
 * `mention-sticky`, which stops requiring an @mention once a thread has
 * engaged once — here the session's own post is the first engagement.
 *
 * The agent-group check in `resolveSession` (session-manager.ts) is untouched
 * and stays as it is. It guards the WIRED path, where two agents share one
 * chat and a binding must never hand one of them the other's session. Here the
 * binding is not a filter applied to a group we already picked — it is what
 * NAMES the group, so it is the authority rather than a check against one.
 */
export async function findBoundSessionFor(mg: MessagingGroup, event: InboundEvent): Promise<Session | undefined> {
  // A top-level post is nobody's thread reply. `threadRootMessageId` parses
  // the root out of the inbound id rather than rebuilding the composed form,
  // because a rebuilt guess that stops matching fails by silently finding
  // nothing — see its own note in db/sessions.ts.
  if (!event.threadId) return undefined;

  // AN OWNER'S REFUSAL OUTRANKS A BINDING. `denied_at` is a person saying this
  // channel may not be used, and a session that opened a thread there before
  // the refusal must not be the way back in. Checked here rather than at the
  // call sites so it cannot be forgotten by whichever one is added next.
  if (mg.denied_at) return undefined;

  return findSessionBoundToThread(mg.id, threadRootMessageId(event.threadId));
}

/**
 * Deliver into a session already known to be bound to this thread.
 *
 * Split from the lookup because the two call sites need it at different
 * moments: the unwired branch has to ask BEFORE it decides the channel is
 * uninteresting, and it resolves the sender only once a binding is found.
 *
 * @param wiredHere Every agent group this chat's wiring names. A group in
 *   this set is skipped whatever the wired pass decided about it — see the
 *   note on the check itself. The unwired caller passes an empty set, and it
 *   is empty by construction there rather than by choice.
 * @returns Whether a delivery happened, so the caller neither records the
 *   message as dropped nor escalates the channel for registration.
 */
export async function deliverToBoundSession(
  mg: MessagingGroup,
  event: InboundEvent,
  userId: string | null,
  bound: Session,
  wiredHere: Set<string>,
  accessGate: AccessGateFn | null,
): Promise<boolean> {
  // A WIRING'S DECISION IS FINAL, including its refusals. If this group is
  // wired to this chat, the pass above already ran the full stack for it —
  // engage_mode, the access gate, sender_scope — and either delivered or
  // deliberately did not. Re-deciding here would consult a strictly smaller
  // set of gates than the wiring asked for, so every refusal it reversed would
  // be a bypass rather than a delivery:
  //
  //   - `engage_mode: 'mention'` with `drop`: the loop refuses an unmentioned
  //     reply, and an admin who required a literal mention every time would
  //     silently get mention-sticky for the life of the thread.
  //   - `sender_scope` denying an unknown sender: the loop refuses, and the
  //     refusal is deliberately kept OUT of any served set so accumulate
  //     cannot store the message either. Delivering here would hand that
  //     sender the reach two gates just denied.
  //
  // Both are reachable because the bind hook claims ANY session whose root
  // post lands (delivery.ts), not only a worker's. So this check is what keeps
  // the pass additive; without it the pass is a hole that widens with every
  // thread an ordinary wired agent opens.
  if (wiredHere.has(bound.agent_group_id)) return false;

  const agentGroup = await getAgentGroup(bound.agent_group_id);
  if (!agentGroup) return false;

  // A binding grants reach into one thread. It does not grant an untrusted
  // sender past the access gate, which is a decision about the PERSON rather
  // than about the conversation — so it is asked here exactly as the wired
  // loop asks it.
  //
  // `sender_scope` and `engage_mode` are genuinely absent rather than skipped:
  // both are columns on a `messaging_group_agents` row, and the check above
  // guarantees this group has none for this chat. There is no policy here to
  // consult, which is exactly why there must be no wired group here either.
  if (accessGate && !(await accessGate(event, userId, mg, bound.agent_group_id)).allowed) return false;

  // The reply address the session will answer on. `replyTo` is operator intent
  // from the CLI admin transport and wins, as it does on the wired path.
  const deliveryAddr = event.replyTo ?? {
    channelType: event.channelType,
    platformId: event.platformId,
    threadId: event.threadId,
  };

  // The command gate runs on every other inbound door, so it runs on this one.
  // Skipping it would make a bound thread the one place an admin command
  // reaches a session without being classified — a hole that widens with every
  // channel a worker is granted.
  if (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') {
    const gate = await gateCommand(event.message.content, userId, bound.agent_group_id);
    if (gate.action === 'filter') {
      log.debug('Filtered command dropped by gate (bound session)', { agentGroupId: bound.agent_group_id });
      return false;
    }
    if (gate.action === 'deny') {
      await writeOutboundDirect(bound.agent_group_id, bound.id, {
        id: `deny-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: deliveryAddr.platformId,
        channelType: deliveryAddr.channelType,
        threadId: deliveryAddr.threadId,
        content: JSON.stringify({ text: `Permission denied: ${gate.command} requires admin access.` }),
      });
      log.info('Admin command denied by gate (bound session)', {
        command: gate.command,
        userId,
        agentGroupId: bound.agent_group_id,
      });
      return false;
    }
  }

  // No `backfillNewSession` and no `fanInboundMessage`, and neither is an
  // omission. Backfill seeds a session at BIRTH and this one is long alive.
  // The cross-session fan copies a message to sibling sessions of the same
  // conversation, and this session has none here: its `messaging_group_id`
  // belongs to whatever spawned it, not to this chat, so it is a guest in the
  // thread rather than a member of the chat's session family.
  await writeSessionMessage(bound.agent_group_id, bound.id, {
    id: messageIdForAgent(event.message.id, bound.agent_group_id),
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: deliveryAddr.platformId,
    channelType: deliveryAddr.channelType,
    threadId: deliveryAddr.threadId,
    content: event.message.content,
    trigger: true,
  });

  // Re-read before waking: `writeSessionMessage` can change container state,
  // and `requestWake` decides from the row rather than from this copy.
  const fresh = await getSession(bound.id);
  if (fresh) await requestWake(fresh, 'inbound-message');

  log.info('Message routed to a bound session', {
    sessionId: bound.id,
    agentGroup: bound.agent_group_id,
    agentGroupName: agentGroup.name,
    messagingGroupId: mg.id,
    threadId: event.threadId,
    userId,
  });
  return true;
}

/**
 * When fanning out, the same inbound message lands in multiple per-agent
 * session DBs. messages_in.id is PRIMARY KEY, so reuse of the raw id would
 * collide across sessions (or, more subtly, within one session if re-routed
 * after a retry). Namespace by agent_group_id to keep ids unique per session.
 */
export function messageIdForAgent(baseId: string | undefined, agentGroupId: string): string {
  const id = baseId && baseId.length > 0 ? baseId : `gen-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${id}:${agentGroupId}`;
}
