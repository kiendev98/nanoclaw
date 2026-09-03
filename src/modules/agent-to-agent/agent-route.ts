/**
 * Agent-to-agent message routing.
 *
 * Outbound messages with `channel_type === 'agent'` target another agent
 * group rather than a channel. Permission is enforced via `agent_destinations` —
 * the source agent must have a row for the target. Content is copied into the
 * target's inbound DB; if the source message had `files` (from `send_file`),
 * the actual bytes are copied from the source's outbox into the target's
 * `inbox/<a2a-msg-id>/` directory and surfaced to the target agent as
 * `attachments` (existing formatter convention — see formatter.ts:230).
 * The target agent can then forward the file onward via its own `send_file`
 * call using the absolute `/workspace/inbox/<a2a-msg-id>/<filename>` path.
 *
 * Self-messages are always allowed (used for system notes injected back into
 * an agent's own session, e.g. post-approval follow-up prompts).
 *
 * Core delivery.ts dispatches into this via a dynamic import guarded by a
 * `channel_type === 'agent'` check. When the module is absent the check in
 * core throws with a "module not installed" message so retry → mark failed.
 */
import fs from 'fs';
import path from 'path';

import { isSafeAttachmentName } from '../../attachment-safety.js';
import { ensureContainedInboxDir, isPathInside } from '../../inbox-safety.js';
import { envValue } from '../../env.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { GuardDenyError, guard } from '../../guard/index.js';
import { log } from '../../log.js';
import { resolveSession, sessionDir, withExistingMailboxSession, writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { requestApproval } from '../approvals/index.js';
import { A2A_MESSAGE_GATE_ACTION, a2aSend } from './guard.js';

export { isSafeAttachmentName };
export { A2A_MESSAGE_GATE_ACTION } from './guard.js';

export interface ForwardedAttachment {
  name: string;
  filename: string;
  type: 'file';
  localPath: string;
}

/**
 * Copy file attachments from the source agent's outbox into the target
 * agent's inbox. Returns attachments using the formatter's existing
 * `{name, type, localPath}` convention — target agent reads `localPath`
 * as relative to `/workspace/`, matching how channel-inbound attachments
 * are surfaced today.
 *
 * Missing source files and unsafe (path-traversal) filenames are skipped
 * with a warning rather than failing the whole route — a bad filename
 * reference shouldn't kill the accompanying text.
 */
export function forwardAttachedFiles(
  source: { agentGroupId: string; sessionId: string; messageId: string; filenames: string[] },
  target: { agentGroupId: string; sessionId: string; messageId: string },
): ForwardedAttachment[] {
  if (source.filenames.length === 0) return [];

  if (!isSafeAttachmentName(source.messageId)) {
    log.warn('agent-route: rejecting unsafe source outbox message id', { sourceMsgId: source.messageId });
    return [];
  }

  const sourceDir = path.join(sessionDir(source.agentGroupId, source.sessionId), 'outbox', source.messageId);
  if (!fs.existsSync(sourceDir)) {
    log.warn('agent-route: source outbox dir missing, no files forwarded', {
      sourceMsgId: source.messageId,
      sourceDir,
    });
    return [];
  }

  let realSourceDir: string;
  try {
    const sourceDirStat = fs.lstatSync(sourceDir);
    if (!sourceDirStat.isDirectory() || sourceDirStat.isSymbolicLink()) {
      log.warn('agent-route: rejecting unsafe source outbox dir', {
        sourceMsgId: source.messageId,
        sourceDir,
      });
      return [];
    }
    realSourceDir = fs.realpathSync(sourceDir);
  } catch (err) {
    log.warn('agent-route: failed to inspect source outbox dir', {
      sourceMsgId: source.messageId,
      sourceDir,
      err,
    });
    return [];
  }

  // Target-side containment — shared with the channel-inbound path. A
  // compromised target agent can write inside its own session dir, so it could
  // pre-place `inbox` (or `inbox/<future-msgId>`) as a symlink pointing
  // anywhere host-writable; ensureContainedInboxDir refuses the symlink before
  // any copy lands outside the sandbox (#2828, CWE-59).
  const inboxRoot = path.join(sessionDir(target.agentGroupId, target.sessionId), 'inbox');
  const targetInboxDir = ensureContainedInboxDir(inboxRoot, target.messageId, {
    targetGroup: target.agentGroupId,
    targetSession: target.sessionId,
    targetMsgId: target.messageId,
  });
  if (!targetInboxDir) {
    return [];
  }

  const attachments: ForwardedAttachment[] = [];
  for (const filename of source.filenames) {
    if (!isSafeAttachmentName(filename)) {
      log.warn('agent-route: rejecting unsafe attachment filename (path traversal attempt?)', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const src = path.join(sourceDir, filename);
    let realSrc: string;
    try {
      const srcStat = fs.lstatSync(src);
      if (!srcStat.isFile() || srcStat.isSymbolicLink()) {
        log.warn('agent-route: rejecting unsafe source outbox file', {
          sourceMsgId: source.messageId,
          filename,
        });
        continue;
      }
      realSrc = fs.realpathSync(src);
    } catch {
      log.warn('agent-route: referenced file missing in source outbox, skipped', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    if (!isPathInside(realSourceDir, realSrc)) {
      log.warn('agent-route: rejecting source file outside source outbox dir', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const dst = path.join(targetInboxDir, filename);
    try {
      // COPYFILE_EXCL: fail with EEXIST rather than follow or overwrite a
      // pre-placed symlink / existing file at dst — the host is the sole
      // writer of these attachments.
      fs.copyFileSync(realSrc, dst, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      log.warn('agent-route: refusing to write target inbox file', {
        sourceMsgId: source.messageId,
        targetMsgId: target.messageId,
        filename,
        err,
      });
      continue;
    }
    attachments.push({
      name: filename,
      filename,
      type: 'file',
      localPath: `inbox/${target.messageId}/${filename}`,
    });
  }
  return attachments;
}

export interface RoutableAgentMessage {
  id: string;
  platform_id: string | null;
  content: string;
  /**
   * For replies, the id of the inbound message being replied to. The
   * container's formatter sets this from the first inbound in the batch
   * (`container/agent-runner/src/formatter.ts`). Used here to route the
   * reply back to the originating session — see `resolveTargetSession`.
   */
  in_reply_to: string | null;
}

/**
 * Pick which session of `targetAgentGroupId` should receive this a2a message.
 *
 * Three layers, highest-fidelity first:
 *
 * 1. **Direct return-path** (in_reply_to lookup): if the message is a reply
 *    (`in_reply_to` set), open the source agent's inbound DB and read the
 *    triggering row's `source_session_id`. That column was stamped when the
 *    original outbound was routed — it's the session that started the
 *    conversation, and replies should land there even when the target has
 *    multiple active sessions.
 *
 * 2. **Peer-affinity fallback**: if (1) misses (in_reply_to is null or the
 *    referenced row isn't an a2a inbound), look up the most recent a2a
 *    inbound *from the target agent group* in source's inbound and use its
 *    `source_session_id`. The intuition: the last time this peer talked to
 *    me, which target session was driving? Route the reply there, since
 *    that's the session most plausibly in active conversation.
 *
 * 3. **Newest active session**: legacy heuristic. Used when no prior a2a
 *    has been recorded with `source_session_id` (e.g. fresh installs,
 *    pre-migration data).
 */
async function resolveTargetSession(
  msg: RoutableAgentMessage,
  sourceSession: Session,
  targetAgentGroupId: string,
): Promise<Session> {
  const originSessionId = await withExistingMailboxSession(sourceSession.agent_group_id, sourceSession.id, (srcDb) => {
    let origin: string | null = null;
    if (msg.in_reply_to) {
      origin = srcDb.getInboundSourceSessionId(msg.in_reply_to);
    }
    if (!origin) {
      // Peer-affinity fallback — covers the case where the container's
      // outbound write didn't carry in_reply_to (e.g. legacy MCP send_message
      // path, container running pre-fix code).
      origin = srcDb.getMostRecentPeerSourceSessionId(targetAgentGroupId);
    }
    return origin;
  });
  if (originSessionId) {
    const candidate = await getSession(originSessionId);
    if (candidate && candidate.agent_group_id === targetAgentGroupId && candidate.status === 'active') {
      return candidate;
    }
  }
  return (await resolveSession(targetAgentGroupId, null, null, 'agent-shared')).session;
}

/**
 * What became of an a2a message: delivered to the target's inbox, or held on
 * an `agent_message_policies` card. Reported rather than inferred because a
 * caller that speaks for the sender — `spawn_worker`, which delivers a brief
 * on the orchestrator's behalf — must not tell it the brief arrived when an
 * admin is still holding it.
 */
export type AgentRouteOutcome = 'delivered' | 'held';

/**
 * LOOP BREAKER FOR THE AGENT LANE.
 *
 * Two agents can sustain each other indefinitely, and neither is
 * misbehaving when they do. A turn that ends without a `<message>` envelope
 * is delivered to whoever sent the inbound (`deliverErrorResult`,
 * container/agent-runner/src/poll-loop.ts) — correct for a human channel,
 * where an error is a terminus. On the agent lane the recipient WAKES and
 * takes a turn, so the same delivery is a stimulus. If both agents fail the
 * same way — a shared quota, a bad model id, an expired credential — each
 * one's failure wakes the other and the pair runs until the process dies.
 *
 * Observed, not theorised: 85 routes between one worker and its
 * orchestrator, alternating at ~1/second for 93 seconds, every one of them
 * carrying `You've hit your session limit`. It ended at a host restart.
 *
 * THE HAZARD WAS ALREADY KNOWN AT THE OTHER BOUNDARY. `SLACK_A2A_MAX_HOPS`
 * exists for exactly this shape and has a counter, a budget and a reset. But
 * it lives in the Slack bridge, and the agent lane is a direct SQLite write
 * between two session mailboxes — it never touches Slack, so it inherited
 * none of that. The guard was attached to the transport where the danger was
 * first noticed rather than to the concept that carries it.
 *
 * THE WAKE IS THROTTLED, NOT THE MESSAGE, and that choice is the whole
 * design. Refusing to route would either throw — pushing a delivered-and-
 * correct message into the retry path, and losing a brief `spawn_worker`
 * promised — or need a third outcome every caller must learn. The wake is
 * the only thing that turns an inbox row into another turn, so suppressing
 * it breaks the cycle and costs nothing: the row is written, and the peer
 * reads it on its next natural wake. A throttled lane loses latency, never
 * content.
 *
 * A SLIDING WINDOW RATHER THAN A HOP COUNT, because it needs no reset hook.
 * Slack's counter resets when a human speaks, which works there because the
 * bridge sees every human message. This lane sees none, so a hop count would
 * be a one-way budget that a long-lived pair exhausts legitimately and never
 * regains. A window self-heals: a pair that goes quiet is unthrottled by the
 * passage of time alone.
 *
 * Keyed per ORDERED pair, so a runaway between two agents cannot throttle a
 * third, and a worker flooding its orchestrator does not gag the replies.
 * In memory, like Slack's: a restart clears it, which is acceptable for a
 * guard whose whole job is to stop a burst that a restart also stops.
 */
const A2A_WAKE_WINDOW_MS = 60_000;
const A2A_MAX_WAKES_PER_WINDOW = Number.parseInt(envValue('NANOCLAW_A2A_MAX_WAKES_PER_MIN') ?? '', 10);
/** Generous by design: the observed loop ran at ~27 wakes/min in one direction. */
const A2A_WAKE_BUDGET =
  Number.isInteger(A2A_MAX_WAKES_PER_WINDOW) && A2A_MAX_WAKES_PER_WINDOW > 0 ? A2A_MAX_WAKES_PER_WINDOW : 20;

/** Wake timestamps per `${from}->${to}`, trimmed to the window on each read. */
const a2aWakes = new Map<string, number[]>();

/**
 * Record this wake and say whether the lane still has budget.
 *
 * Exported for the test only; nothing else should call it. Trimming on read
 * rather than on a timer keeps the map bounded by the number of ACTIVE pairs:
 * an idle pair's entry is dropped the next time it is touched.
 *
 * A DENIED ATTEMPT STILL CONSUMES WINDOW — the push precedes the check on
 * purpose, so a pair sustaining more than the budget stays denied until its
 * rate actually drops, rather than being let through one per window.
 *
 * The array is capped at the budget because nothing past that point changes
 * the answer: once the count exceeds the budget the lane is denied whatever
 * else arrives, so retaining a timestamp per attempt would only make a
 * runaway pair — the exact case this exists for — pay an O(n) filter per
 * call and hold every timestamp of the burst resident.
 */
export function _a2aWakeAllowed(from: string, to: string, now = Date.now()): boolean {
  const key = `${from}->${to}`;
  const recent = (a2aWakes.get(key) ?? []).filter((at) => now - at < A2A_WAKE_WINDOW_MS);
  recent.push(now);
  const allowed = recent.length <= A2A_WAKE_BUDGET;
  a2aWakes.set(key, recent.length > A2A_WAKE_BUDGET + 1 ? recent.slice(-(A2A_WAKE_BUDGET + 1)) : recent);
  return allowed;
}

/** Test seam — the window is real time, so a suite must be able to clear it. */
export function _resetA2aWakesForTesting(): void {
  a2aWakes.clear();
}

export async function routeAgentMessage(
  msg: RoutableAgentMessage,
  session: Session,
  opts: { grant?: PendingApproval } = {},
): Promise<AgentRouteOutcome> {
  const sourceAgentGroupId = session.agent_group_id;
  const targetAgentGroupId = msg.platform_id;
  if (!targetAgentGroupId) {
    throw new Error(`agent-to-agent message ${msg.id} is missing a target agent group id`);
  }

  // The a2a.send decision (guard.ts) carries the checks verbatim in their
  // original order: destination ACL deny, target-exists deny, self-send
  // allow, agent_message_policies hold. An approved replay carries the
  // grant — the hold is satisfied but the structure is re-checked live, so
  // revoking a destination between hold and approve blocks delivery.
  const decision = await guard(a2aSend, {
    actor: { kind: 'agent', agentGroupId: sourceAgentGroupId, sessionId: session.id },
    resource: { from: sourceAgentGroupId, to: targetAgentGroupId },
    payload: { id: msg.id, platform_id: targetAgentGroupId, content: msg.content, in_reply_to: msg.in_reply_to },
    grant: opts.grant ?? null,
  });

  if (decision.effect === 'deny') {
    throw new GuardDenyError(decision.reason);
  }

  // Gated edge: hold the message and return (not throw) so the delivery loop
  // consumes the outbound row; `applyA2aMessageGate` re-enters here with the
  // grant on approve.
  if (decision.effect === 'hold') {
    const sourceName = (await getAgentGroup(sourceAgentGroupId))?.name ?? sourceAgentGroupId;
    const targetName = (await getAgentGroup(targetAgentGroupId))?.name ?? targetAgentGroupId;
    await requestApproval({
      session,
      agentName: sourceName,
      action: A2A_MESSAGE_GATE_ACTION,
      approverUserId: decision.approverUserId,
      title: 'Message approval',
      question: buildGateQuestion(sourceName, targetName, msg.content),
      payload: {
        id: msg.id,
        platform_id: targetAgentGroupId,
        content: msg.content,
        in_reply_to: msg.in_reply_to,
      },
    });
    log.info('Agent message held for approval', {
      from: sourceAgentGroupId,
      to: targetAgentGroupId,
      msgId: msg.id,
    });
    return 'held';
  }

  await performAgentRoute(msg, session, targetAgentGroupId);
  return 'delivered';
}

const GATE_CARD_BODY_MAX = 1500;

function parseMessageContent(contentStr: string): { text: string; files: string[] } {
  try {
    const parsed = JSON.parse(contentStr) as { text?: unknown; files?: unknown };
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      files: Array.isArray(parsed.files) ? parsed.files.filter((f): f is string => typeof f === 'string') : [],
    };
  } catch {
    return { text: contentStr, files: [] };
  }
}

function buildGateQuestion(sourceName: string, targetName: string, contentStr: string): string {
  const { text, files } = parseMessageContent(contentStr);
  const body = text.length > GATE_CARD_BODY_MAX ? `${text.slice(0, GATE_CARD_BODY_MAX)}… (truncated)` : text;
  const lines = [`Agent "${sourceName}" wants to send a message to "${targetName}":`, '', body];
  if (files.length > 0) lines.push('', `Attachments: ${files.join(', ')}`);
  lines.push(
    '',
    `Approve, Reject, or "Reject with reason…" to decline and then type a short reason I'll relay to "${sourceName}".`,
  );
  return lines.join('\n');
}

/**
 * Cross-session route: pick the target session, forward files, write to its
 * inbound DB, wake it. Module-private — the only door is routeAgentMessage's
 * guard decision (the approve continuation re-enters with a grant rather
 * than calling this directly).
 */
async function performAgentRoute(
  msg: RoutableAgentMessage,
  session: Session,
  targetAgentGroupId: string,
): Promise<void> {
  const targetSession = await resolveTargetSession(msg, session, targetAgentGroupId);
  const a2aMsgId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // If the source message references files (via `send_file`), forward the
  // bytes from the source's outbox into the target's inbox so the target
  // agent can actually see and re-send them. Without this, agent-to-agent
  // file attachments look like they arrive but the target has no way to
  // read the bytes — they live in a session dir it doesn't mount.
  const forwardedContent = forwardFileAttachments(msg, a2aMsgId, session, targetAgentGroupId, targetSession.id);

  // DECIDED BEFORE THE WRITE, and this ordering is the whole fix. Suppressing
  // `requestWake` after the write accomplishes nothing: `writeSessionMessage`
  // ends with `enqueueSessionReconcile` (session-manager.ts), whose queue
  // pumps IMMEDIATELY and calls `requestWake` itself for any row that
  // `countDueMessages` counts. A throttle that only skips the call below is a
  // log line; the peer is woken milliseconds later by the reconcile.
  //
  // The only way to withhold a wake is to write a row nothing counts.
  // `trigger: false` is that row, and both gates already honour it — the
  // host's `countDueMessages` (`WHERE ... trigger = 1`) and the container's
  // accumulate gate in poll-loop. Both leave it `pending`, so it rides along
  // on the next genuine trigger. That is the "delivered but not woken"
  // contract this throttle always claimed and did not implement.
  const wakeAllowed = _a2aWakeAllowed(session.agent_group_id, targetAgentGroupId);

  await writeSessionMessage(targetAgentGroupId, targetSession.id, {
    id: a2aMsgId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: forwardedContent,
    sourceSessionId: session.id,
    trigger: wakeAllowed,
  });
  log.info('Agent message routed', {
    from: session.agent_group_id,
    to: targetAgentGroupId,
    targetSession: targetSession.id,
    a2aMsgId,
    forwardedFileCount: countForwardedFiles(forwardedContent),
  });

  if (!wakeAllowed) {
    log.error('Agent lane throttled — message delivered but peer not woken', {
      from: session.agent_group_id,
      to: targetAgentGroupId,
      targetSession: targetSession.id,
      a2aMsgId,
      hint: 'two agents are waking each other faster than a conversation; the row is written with trigger=0 and rides along on the next genuine trigger',
    });
    return;
  }

  const fresh = await getSession(targetSession.id);
  if (!fresh) return;
  await requestWake(fresh, 'inbound-message');
}

/**
 * Parse source content, copy any referenced `files` from source outbox to
 * target inbox, and return a JSON string with an `attachments` array added
 * (formatter.ts:223 already knows how to render this shape).
 *
 * If the source content isn't JSON or has no files, returns the original
 * content string unchanged — this is safe to call on every route.
 */
function forwardFileAttachments(
  msg: RoutableAgentMessage,
  a2aMsgId: string,
  sourceSession: Session,
  targetAgentGroupId: string,
  targetSessionId: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return msg.content;
  }
  const files = parsed.files as unknown;
  if (!Array.isArray(files) || files.length === 0) return msg.content;
  const filenames = files.filter((f): f is string => typeof f === 'string');
  if (filenames.length === 0) return msg.content;

  const attachments = forwardAttachedFiles(
    {
      agentGroupId: sourceSession.agent_group_id,
      sessionId: sourceSession.id,
      messageId: msg.id,
      filenames,
    },
    {
      agentGroupId: targetAgentGroupId,
      sessionId: targetSessionId,
      messageId: a2aMsgId,
    },
  );

  // Merge into any existing `attachments` (unlikely in a2a context but safe).
  const existing = Array.isArray(parsed.attachments) ? (parsed.attachments as Record<string, unknown>[]) : [];
  parsed.attachments = [...existing, ...attachments];

  return JSON.stringify(parsed);
}

function countForwardedFiles(contentStr: string): number {
  try {
    const parsed = JSON.parse(contentStr);
    return Array.isArray(parsed.attachments) ? parsed.attachments.length : 0;
  } catch {
    return 0;
  }
}
