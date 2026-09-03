/**
 * Inbound message routing.
 *
 * Channel adapter event → resolve messaging group → sender resolver →
 * resolve/pick agent → access gate → resolve/create session → write
 * messages_in → wake container.
 *
 * Fan-out runs in two passes, and the second one exists because the first
 * cannot see it. The wired pass asks `messaging_group_agents` who is wired to
 * this chat; the bound pass asks which session OPENED this thread, which is
 * how a message reaches an agent that is deliberately not wired here — a repo
 * worker granted one channel for one job. The second is strictly additive:
 * every wired agent is served first and identically, so nothing that worked
 * before this existed behaves differently now. See `deliverToBoundSession`.
 *
 * Two module hooks (registered by the permissions module):
 *   - `setSenderResolver` runs BEFORE agent resolution so user rows get
 *     upserted even if the message ends up dropped by agent wiring.
 *     Without the module, userId is null and downstream code tolerates it.
 *   - `setAccessGate` runs AFTER agent resolution so policy decisions can
 *     branch on the target agent group. Without the module, access is
 *     allow-all.
 *
 * `dropped_messages` is core audit infra. Core writes rows for structural
 * drops (no agent wired, no trigger match); the access gate writes rows
 * for policy refusals.
 */
import { getChannelAdapter, getChannelDefaults } from './channels/channel-registry.js';
import { resolveThreadPolicy, resolveUnknownSenderPolicy } from './channels/channel-defaults.js';
import { gateCommand } from './command-gate.js';
import { getAgentGroup } from './db/agent-groups.js';
import { recordDroppedMessage } from './db/dropped-messages.js';
import {
  createMessagingGroupIfAbsent,
  getMessagingGroupAgents,
  getMessagingGroupWithAgentCount,
} from './db/messaging-groups.js';
import { findSessionBoundToThread, findSessionForAgent, threadRootMessageId } from './db/sessions.js';
import { backfillNewSession, fanInboundMessage } from './modules/cross-session-context/index.js';
import { startTypingRefresh, stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { resolveSession, writeSessionMessage, writeOutboundDirect } from './session-manager.js';
import { requestWake } from './request-wake.js';
import { getSession } from './db/sessions.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent, Session } from './types.js';
import type { InboundEvent } from './channels/adapter.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Sender-resolver hook. Runs before agent resolution.
 *
 * The permissions module registers this to extract the sender's namespaced
 * user id and upsert the users row. Returns null when the payload doesn't
 * carry enough info to identify a sender. Without the hook, every message
 * arrives at the gate with userId=null.
 */
export type SenderResolverFn = (event: InboundEvent) => string | null | Promise<string | null>;

let senderResolver: SenderResolverFn | null = null;

export function setSenderResolver(fn: SenderResolverFn): void {
  if (senderResolver) {
    log.warn('Sender resolver overwritten');
  }
  senderResolver = fn;
}

/**
 * Access-gate hook. Runs after agent resolution.
 *
 * The permissions module registers this; without it, core defaults to
 * allow-all. The gate receives the raw event so it can extract the sender
 * name for audit-trail purposes, and it is responsible for recording its
 * own `dropped_messages` row on refusal (structural drops are already
 * recorded by core before the gate runs).
 */
export type AccessGateResult = { allowed: true } | { allowed: false; reason: string };

export type AccessGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agentGroupId: string,
) => AccessGateResult | Promise<AccessGateResult>;

let accessGate: AccessGateFn | null = null;

export function setAccessGate(fn: AccessGateFn): void {
  if (accessGate) {
    log.warn('Access gate overwritten');
  }
  accessGate = fn;
}

/**
 * Per-wiring sender-scope hook. Runs alongside the access gate for each
 * agent that would otherwise engage — lets the permissions module enforce
 * `sender_scope='known'` on wirings that are stricter than the messaging
 * group's `unknown_sender_policy`. When the hook isn't registered (module
 * not installed), sender_scope is a no-op.
 */
export type SenderScopeGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agent: MessagingGroupAgent,
) => AccessGateResult | Promise<AccessGateResult>;

let senderScopeGate: SenderScopeGateFn | null = null;

export function setSenderScopeGate(fn: SenderScopeGateFn): void {
  if (senderScopeGate) {
    log.warn('Sender-scope gate overwritten');
  }
  senderScopeGate = fn;
}

/**
 * Message-interceptor hook. Runs at the very top of routeInbound, before
 * messaging-group resolution. When an interceptor returns true the message is
 * consumed and routing stops. Multiple interceptors may register; they run in
 * registration order and the first to claim the message (return true) wins.
 *
 * Used by modules to capture free-text DM replies during multi-step approval
 * flows — the permissions module (agent naming during channel registration)
 * and the approvals module (reject-with-reason capture).
 */
export type MessageInterceptorFn = (event: InboundEvent) => Promise<boolean>;

const messageInterceptors: MessageInterceptorFn[] = [];

export function registerMessageInterceptor(fn: MessageInterceptorFn): void {
  messageInterceptors.push(fn);
}

/**
 * Channel-registration hook. Runs when the router sees a mention/DM on a
 * messaging group that has no wirings AND hasn't been denied. The hook is
 * expected to escalate to an owner (card, etc.) and arrange for future
 * replay via routeInbound after approval. Fire-and-forget from the
 * router's perspective.
 *
 * Registered by the permissions module. Without the module the router
 * silently records the drop with reason='no_agent_wired' and moves on.
 */
export type ChannelRequestGateFn = (mg: MessagingGroup, event: InboundEvent) => Promise<void>;

let channelRequestGate: ChannelRequestGateFn | null = null;

export function setChannelRequestGate(fn: ChannelRequestGateFn): void {
  if (channelRequestGate) {
    log.warn('Channel-request gate overwritten');
  }
  channelRequestGate = fn;
}

/**
 * Session-created hook. When an engaged (waking) message creates a
 * brand-new session, registered hooks are notified after the triggering
 * message is written to the session's inbound DB, with the resolved
 * messaging group, thread id, session mode, and triggering message.
 *
 * Channel modules can use it for platform-specific conversation bootstrap
 * (thread naming, retiring onboarding affordances) without the router
 * carrying platform timing knowledge. The hook fires for every
 * created+engaged session — is_group / session-mode filtering is the
 * consumer's business.
 *
 * Fire-and-forget: hooks are try/caught (and async rejections logged), so
 * a failing hook can never affect routing or the container wake. No-op
 * when nothing is registered.
 */
export interface SessionCreatedEvent {
  /** The just-created session. */
  session: Session;
  /** The messaging group the triggering message arrived on. */
  mg: MessagingGroup;
  /** Platform address of the triggering inbound event. */
  platformId: string;
  /** Resolved thread id after the wiring's thread policy (null = no thread). */
  threadId: string | null;
  /** Resolved session mode after the wiring's thread policy. */
  sessionMode: MessagingGroupAgent['session_mode'];
  /** The triggering inbound message as received from the adapter. */
  message: { id: string; kind: string; content: string; timestamp: string };
}

export type SessionCreatedHook = (event: SessionCreatedEvent) => void | Promise<void>;

const sessionCreatedHooks: SessionCreatedHook[] = [];

export function registerSessionCreatedHook(hook: SessionCreatedHook): void {
  sessionCreatedHooks.push(hook);
}

function dispatchSessionCreated(event: SessionCreatedEvent): void {
  for (const hook of sessionCreatedHooks) {
    try {
      Promise.resolve(hook(event)).catch((err) =>
        log.error('Session-created hook failed', { sessionId: event.session.id, err }),
      );
    } catch (err) {
      log.error('Session-created hook threw', { sessionId: event.session.id, err });
    }
  }
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

/**
 * Route an inbound message from a channel adapter to the correct session.
 * Creates messaging group + session if they don't exist yet.
 */
export async function routeInbound(event: InboundEvent): Promise<void> {
  // Pre-route interceptors — let modules consume messages before any routing
  // (e.g. free-text DM replies during multi-step approval flows). They run in
  // registration order; the first to claim the message stops routing. The
  // sequential await is intentional — first-to-claim is order-dependent.
  for (const intercept of messageInterceptors) {
    if (await intercept(event)) return;
  }

  // 0. Apply the adapter's thread policy. Non-threaded adapters (Telegram,
  //    WhatsApp, iMessage, email) collapse threads to the channel. Resolved
  //    by the RECEIVING instance — sibling instances of one platform can
  //    differ in thread support.
  const adapter = getChannelAdapter(event.instance ?? event.channelType);
  if (adapter && !adapter.supportsThreads) {
    event = { ...event, threadId: null };
  }

  const isMention = event.message.isMention === true;

  // 1. Combined lookup: messaging_group row + count of wired agents in a
  //    single query. Cheap short-circuit for the common "unwired channel"
  //    case — one DB read and we're out, no auto-create, no sender
  //    resolution, no log spam. Exact-on-instance: an unknown named
  //    instance falls through to auto-create rather than hijacking a
  //    sibling instance's row.
  const found = await getMessagingGroupWithAgentCount(
    event.channelType,
    event.platformId,
    event.instance ?? event.channelType,
  );

  let mg: MessagingGroup;
  let agentCount: number;
  if (!found) {
    // No messaging_groups row. Auto-create only when the message warrants
    // attention (the bot was addressed — @mention or DM). Plain chatter in
    // channels we merely sit in stays silent — no row, no DB writes.
    if (!isMention) return;
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: event.channelType,
      platform_id: event.platformId,
      // Persist the receiving instance — without this, the first bot's row
      // would absorb every sibling instance's traffic.
      instance: event.instance ?? event.channelType,
      name: null,
      is_group: event.message.isGroup ? 1 : 0,
      // Policy from the receiving channel's declared defaults (DM vs group
      // context); undeclared adapters resolve through the behavior-faithful
      // fallback, which is 'request_approval' in both contexts — identical
      // to the historical hardcode.
      unknown_sender_policy: resolveUnknownSenderPolicy(
        event.instance ?? event.channelType,
        event.message.isGroup === true,
        event.channelType,
      ),
      denied_at: null,
      created_at: new Date().toISOString(),
    };
    const created = await createMessagingGroupIfAbsent(mg);
    const resolved = await getMessagingGroupWithAgentCount(
      event.channelType,
      event.platformId,
      event.instance ?? event.channelType,
    );
    if (!resolved) throw new Error('Messaging group disappeared after first-message insert');
    mg = resolved.mg;
    agentCount = resolved.agentCount;
    if (created) {
      log.info('Auto-created messaging group', {
        id: mgId,
        channelType: event.channelType,
        platformId: event.platformId,
      });
    }
  } else {
    mg = found.mg;
    agentCount = found.agentCount;
  }

  // 1b. No wirings — either silent drop (plain chatter / denied channel) or
  //     escalate to owner for channel-registration approval.
  if (agentCount === 0) {
    // A BINDING IS REACH THIS COUNT CANNOT SEE. `agentCount` counts
    // `messaging_group_agents` rows, and a bound session deliberately has
    // none — that absence is what makes a lent channel die with the session
    // instead of leaving a wiring row behind. So a worker lent a channel no
    // other agent uses would have its replies dropped here, ~160 lines before
    // the fan-out that would have delivered them, with the post it was
    // replying to having gone out perfectly well.
    //
    // The lookup runs first and the sender is resolved only once it hits, so
    // the short-circuit this block exists for still costs one indexed read on
    // an ordinary unwired channel — no auto-create, no sender resolution, no
    // log spam, exactly as before.
    const bound = await findBoundSessionFor(mg, event);
    if (bound) {
      const boundUserId = senderResolver ? await senderResolver(event) : null;
      // `served` is empty on purpose: no wired agent ran, so none was served.
      if (await deliverToBoundSession(mg, event, boundUserId, bound, new Set())) return;
    }

    // A thread reply is engaged by its binding, not by a mention — but with no
    // binding this is an ordinary unwired channel again, and the mention rule
    // decides as it always did.
    if (!isMention) return;
    if (mg.denied_at) {
      log.debug('Message dropped — channel was denied by owner', {
        messagingGroupId: mg.id,
        deniedAt: mg.denied_at,
      });
      return;
    }

    const parsed = safeParseContent(event.message.content);
    await recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: null,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_wired',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });

    if (channelRequestGate) {
      // Fire-and-forget escalation. The gate is expected to build a card,
      // persist pending_channel_approvals, and replay the event via
      // routeInbound after approval. Errors are logged internally — the
      // user's message still stays dropped here either way.
      void channelRequestGate(mg, event).catch((err) =>
        log.error('Channel-request gate threw', { messagingGroupId: mg.id, err }),
      );
    } else {
      log.warn('MESSAGE DROPPED — no agent groups wired and no channel-request gate registered', {
        messagingGroupId: mg.id,
        channelType: event.channelType,
        platformId: event.platformId,
      });
    }
    return;
  }

  // 2. Sender resolution (permissions module upserts the users row as a
  //    side effect so later role/access lookups find a real record).
  //    Without the module, userId is null — downstream tolerates it.
  const userId: string | null = senderResolver ? await senderResolver(event) : null;

  // 3. Fetch wired agents in full (we already know the count is > 0; now
  //    we need their actual rows for fan-out).
  const agents = await getMessagingGroupAgents(mg.id);

  // 4. Fan-out: evaluate each wired agent independently against engage_mode,
  //    sender_scope, and access gate. An agent that engages gets its own
  //    session and container wake. An agent that declines but has
  //    ignored_message_policy='accumulate' still gets the message stored in
  //    its session without triggering a wake so the context is available when it does
  //    engage later. Drop policy = skip silently.
  //
  //    Subscribe (for mention-sticky wirings on threaded platforms) fires
  //    once per message from this loop — the first engaging mention-sticky
  //    wiring triggers adapter.subscribe(...); subsequent wirings don't
  //    re-subscribe (chat.subscribe is idempotent anyway, but the flag
  //    avoids the extra await).
  const parsed = safeParseContent(event.message.content);
  const messageText = parsed.text ?? '';

  // Per-wiring thread policy inputs, resolved once per event. Each wiring's
  // threads override (NULL = inherit) resolves against the channel's declared
  // defaults, hard-bounded by the live adapter's raw capability. Undeclared
  // adapters resolve through the behavior-faithful fallback, so a NULL-threads
  // wiring reproduces the historical supportsThreads-derived routing exactly.
  const channelDefaults = getChannelDefaults(mg.instance ?? mg.channel_type, mg.channel_type);
  const supportsThreads = adapter?.supportsThreads === true;

  let engagedCount = 0;
  let accumulatedCount = 0;
  let subscribed = false;
  // Agent groups this chat's own wiring already handed the message to, either
  // branch. Read by the bound-session pass below, which must not deliver a
  // second copy to a group the loop has served — `messageIdForAgent`
  // namespaces by agent group, so the two writes would collide on
  // `messages_in.id` rather than merely duplicating.
  const served = new Set<string>();

  for (const agent of agents) {
    const agentGroup = await getAgentGroup(agent.agent_group_id);
    if (!agentGroup) continue;

    // Effective thread id for THIS wiring: the event-derived address is
    // policy-stripped when the wiring (or its channel declaration) opts out
    // of threads. event.replyTo is operator intent from the CLI admin
    // transport and is never nulled. Guard: platform thread ids must never
    // collide with the reserved 'system:%' session namespace
    // (src/db/sessions.ts) — they are platform-native identifiers, and this
    // is the only place an inbound thread id enters session resolution.
    const threadsEnabled = resolveThreadPolicy(
      agent.threads ?? null,
      channelDefaults,
      mg.is_group === 1,
      supportsThreads,
    );
    const effectiveThreadId = threadsEnabled ? event.threadId : null;

    const engages = await evaluateEngage(agent, messageText, isMention, mg, effectiveThreadId);

    const accessOk = engages && (!accessGate || (await accessGate(event, userId, mg, agent.agent_group_id)).allowed);
    const scopeOk = engages && (!senderScopeGate || (await senderScopeGate(event, userId, mg, agent)).allowed);

    if (engages && accessOk && scopeOk) {
      await deliverToAgent(agent, agentGroup, mg, event, userId, threadsEnabled, effectiveThreadId, true);
      engagedCount++;
      served.add(agent.agent_group_id);

      // Mention-sticky: ask the adapter to subscribe the thread so the
      // platform's subscribed-message path carries follow-ups without
      // requiring another @mention. Uses this wiring's OWN effective thread
      // id — a non-null value already implies the adapter supports threads
      // (resolveThreadPolicy hard-ANDs the capability). DMs, non-threaded
      // platforms, and thread-opted-out wirings skip.
      if (
        !subscribed &&
        agent.engage_mode === 'mention-sticky' &&
        adapter?.subscribe &&
        effectiveThreadId !== null &&
        mg.is_group !== 0
      ) {
        subscribed = true;
        // Fire-and-forget — subscribe is platform-side bookkeeping and
        // shouldn't block message routing. Errors are logged inside the
        // adapter (or by the promise rejection handler below).
        void adapter.subscribe(event.platformId, effectiveThreadId).catch((err) => {
          log.warn('adapter.subscribe failed', { channelType: event.channelType, threadId: effectiveThreadId, err });
        });
      }
    } else if (agent.ignored_message_policy === 'accumulate' && !(engages && (!accessOk || !scopeOk))) {
      // Accumulate stores the message as silent context. We allow it when
      // engagement simply didn't fire, but NOT when engagement fired and
      // the access/scope gate refused — those refusals are security
      // decisions about an untrusted sender, and silently storing their
      // message (which also stages their attachments to disk via
      // writeSessionMessage → extractAttachmentFiles) is exactly what the
      // gate is meant to prevent.
      await deliverToAgent(agent, agentGroup, mg, event, userId, threadsEnabled, effectiveThreadId, false);
      accumulatedCount++;
      served.add(agent.agent_group_id);
    } else {
      log.debug('Message not engaged for agent (drop policy)', {
        agentGroupId: agent.agent_group_id,
        engage_mode: agent.engage_mode,
        engages,
        accessOk,
        scopeOk,
      });
    }
  }

  // 5. Second pass: a reply inside a thread that some session OPENED, whose
  //    agent group this chat's wiring does not mention.
  //
  //    The wired fan-out above cannot find it. `getMessagingGroupAgents`
  //    answers "who is wired here", and the case this exists for is an agent
  //    that is deliberately NOT wired — a repo worker granted one channel for
  //    one job. It posts, a thread forms around its post, and a human replies
  //    in that thread expecting the thing they are replying to to hear them.
  const boundHere = await findBoundSessionFor(mg, event);
  if (boundHere && (await deliverToBoundSession(mg, event, userId, boundHere, served))) engagedCount++;

  if (engagedCount + accumulatedCount === 0) {
    await recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: userId,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_engaged',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });
  }
}

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
async function findBoundSessionFor(mg: MessagingGroup, event: InboundEvent): Promise<Session | undefined> {
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
 * @param served Agent groups the wired loop already delivered to, engaged or
 *   accumulated. A group in this set is skipped: it has the message, and a
 *   second write would collide on the namespaced `messages_in.id`. The unwired
 *   caller passes an empty set, because no wired agent ran there at all.
 * @returns Whether a delivery happened, so the caller neither records the
 *   message as dropped nor escalates the channel for registration.
 */
async function deliverToBoundSession(
  mg: MessagingGroup,
  event: InboundEvent,
  userId: string | null,
  bound: Session,
  served: Set<string>,
): Promise<boolean> {
  if (served.has(bound.agent_group_id)) return false;

  const agentGroup = await getAgentGroup(bound.agent_group_id);
  if (!agentGroup) return false;

  // A binding grants reach into one thread. It does not grant an untrusted
  // sender past the access gate, which is a decision about the PERSON rather
  // than about the conversation — so it is asked here exactly as the wired
  // loop asks it. `sender_scope` and `engage_mode` are not consulted, because
  // both are columns on a wiring row that does not exist for this session.
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
 * Decide whether a given wired agent should engage on this message.
 *
 *   'pattern'        — regex test on text; '.' = always
 *   'mention'        — bot must be mentioned on the platform. Resolved by
 *                      the adapter (SDK-level) and forwarded as
 *                      `event.message.isMention`. Agent display name
 *                      (`agent_group.name`) is irrelevant — users address
 *                      the bot via its platform username (@botname on
 *                      Telegram, user-id mention on Slack/Discord), not
 *                      via the agent's NanoClaw-side display name. If a
 *                      user wants to disambiguate between multiple agents
 *                      wired to one chat, use engage_mode='pattern' with
 *                      the disambiguator as the regex.
 *   'mention-sticky' — platform mention OR an active per-thread session
 *                      already exists for this (agent, mg, thread). The
 *                      session existence IS our subscription state; once
 *                      a thread has engaged us once, follow-ups arrive
 *                      with no mention and should still fire.
 */
async function evaluateEngage(
  agent: MessagingGroupAgent,
  text: string,
  isMention: boolean,
  mg: MessagingGroup,
  threadId: string | null,
): Promise<boolean> {
  switch (agent.engage_mode) {
    case 'pattern': {
      const pat = agent.engage_pattern ?? '.';
      if (pat === '.') return true;
      try {
        return new RegExp(pat).test(text);
      } catch {
        // Bad regex: fail open so admin sees the agent responding + can fix.
        return true;
      }
    }
    case 'mention':
      return isMention;
    case 'mention-sticky': {
      if (isMention) return true;
      // Sticky follow-up: session already exists for this (agent, mg, thread)
      // — the thread was activated before, keep firing.
      if (mg.is_group === 0) return false; // DMs never use mention-sticky sensibly
      const existing = await findSessionForAgent(agent.agent_group_id, mg.id, threadId);
      return existing !== undefined;
    }
    default:
      // Unrecognized engage_mode (e.g. stale data from a past CLI version,
      // or a direct DB write — the column has no CHECK constraint). Fail
      // closed but leave a trail so this doesn't look like a mystery drop.
      log.warn('Unknown engage_mode — treating as no-engage. Check wiring configuration.', {
        engage_mode: agent.engage_mode,
        wiring_id: agent.id,
      });
      return false;
  }
}

async function deliverToAgent(
  agent: MessagingGroupAgent,
  agentGroup: AgentGroup,
  mg: MessagingGroup,
  event: InboundEvent,
  userId: string | null,
  threadsEnabled: boolean,
  effectiveThreadId: string | null,
  wake: boolean,
): Promise<void> {
  // Apply the resolved thread policy (wiring override AND channel declaration
  // AND adapter capability — resolveThreadPolicy at fanout): thread-enabled
  // wiring in a group chat → per-thread session regardless of wiring
  // session_mode. agent-shared preserved (it's a cross-channel directive the
  // adapter doesn't know about). DMs collapse sub-threads to one session
  // (is_group=0 short-circuit).
  let effectiveSessionMode = agent.session_mode;
  if (threadsEnabled && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
    effectiveSessionMode = 'per-thread';
  }

  const { session, created } = await resolveSession(
    agent.agent_group_id,
    mg.id,
    effectiveThreadId,
    effectiveSessionMode,
  );

  // The inbound row's (channel_type, platform_id, thread_id) is the address
  // the agent's reply will be delivered to. Normally it mirrors the source
  // (stamped from the event, with the wiring's thread policy applied). When
  // the caller supplied `replyTo` (CLI admin transport acting on operator
  // intent), the reply is redirected there — replyTo is exempt from
  // thread-policy stripping.
  const deliveryAddr = event.replyTo ?? {
    channelType: event.channelType,
    platformId: event.platformId,
    threadId: effectiveThreadId,
  };

  // Command gate: classify slash commands before they reach the container.
  // Filtered commands are dropped silently. Denied admin commands get a
  // permission-denied response written directly to messages_out.
  if (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') {
    const gate = await gateCommand(event.message.content, userId, agent.agent_group_id);
    if (gate.action === 'filter') {
      log.debug('Filtered command dropped by gate', { agentGroupId: agent.agent_group_id });
      return;
    }
    if (gate.action === 'deny') {
      await writeOutboundDirect(session.agent_group_id, session.id, {
        id: `deny-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: deliveryAddr.platformId,
        channelType: deliveryAddr.channelType,
        threadId: deliveryAddr.threadId,
        content: JSON.stringify({ text: `Permission denied: ${gate.command} requires admin access.` }),
      });
      log.info('Admin command denied by gate', { command: gate.command, userId, agentGroupId: agent.agent_group_id });
      return;
    }
  }

  if (wake && created) {
    // New-session backfill (cross-session context): a just-born session is
    // seeded with its conversation's top-level timeline from sibling
    // sessions BEFORE the triggering message is written, so replying to
    // something said in another thread lands with that context in view.
    await backfillNewSession(agentGroup, session, mg);
  }

  const messageId = messageIdForAgent(event.message.id, agent.agent_group_id);
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: messageId,
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: deliveryAddr.platformId,
    channelType: deliveryAddr.channelType,
    threadId: deliveryAddr.threadId,
    content: event.message.content,
    trigger: wake,
  });

  if (wake) {
    // Cross-session context: fan the triggering message into sibling
    // sessions of the SAME conversation as trigger=0 'session-echo' rows.
    // Only the engaged branch fans — the accumulate branch above (trigger=0)
    // never does, so ambient backlog is never copied twice. Never throws.
    await fanInboundMessage({
      session,
      mg,
      messageId,
      kind: event.message.kind,
      channelType: deliveryAddr.channelType,
      content: event.message.content,
      timestamp: event.message.timestamp,
    });
  }

  if (wake && created) {
    // A brand-new engaged session: notify registered modules with the
    // resolved wiring context (fire-and-forget — see dispatchSessionCreated).
    dispatchSessionCreated({
      session,
      mg,
      platformId: event.platformId,
      threadId: effectiveThreadId,
      sessionMode: effectiveSessionMode,
      message: {
        id: event.message.id,
        kind: event.message.kind,
        content: event.message.content,
        timestamp: event.message.timestamp,
      },
    });
  }

  log.info('Message routed', {
    sessionId: session.id,
    agentGroup: agent.agent_group_id,
    engage_mode: agent.engage_mode,
    kind: event.message.kind,
    userId,
    wake,
    created,
    agentGroupName: agentGroup.name,
  });

  if (wake) {
    // Typing indicator + wake are only for the engaged branch; accumulated
    // messages sit silently until a real trigger fires.
    // Typing fires via the adapter instance that owns this chat's row.
    startTypingRefresh(
      session.id,
      session.agent_group_id,
      event.channelType,
      event.platformId,
      effectiveThreadId,
      mg.instance,
    );
    const freshSession = await getSession(session.id);
    if (freshSession) {
      const woke = await requestWake(freshSession, 'inbound-message');
      // requestWake never throws — it returns false on transient spawn
      // failure (host-sweep retries). Stop the typing indicator we just
      // started so it doesn't leak; the inbound row stays pending.
      if (!woke) stopTypingRefresh(freshSession.id);
    }
  }
}

/**
 * When fanning out, the same inbound message lands in multiple per-agent
 * session DBs. messages_in.id is PRIMARY KEY, so reuse of the raw id would
 * collide across sessions (or, more subtly, within one session if re-routed
 * after a retry). Namespace by agent_group_id to keep ids unique per session.
 */
function messageIdForAgent(baseId: string | undefined, agentGroupId: string): string {
  const id = baseId && baseId.length > 0 ? baseId : generateId();
  return `${id}:${agentGroupId}`;
}
