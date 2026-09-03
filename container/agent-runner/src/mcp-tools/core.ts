/**
 * Core MCP tools: send_message, send_file, edit_message, add_reaction.
 *
 * All outbound tools resolve destinations via the local destination map
 * (see destinations.ts). Agents reference destinations by name; the map
 * translates name → routing tuple. Permission enforcement happens on
 * the host side in delivery.ts via the agent_destinations table.
 */
import fs from 'fs';
import path from 'path';

import { findByName, getAllDestinations } from '../destinations.js';
import { getMessageIdBySeq, getRoutingBySeq, writeMessageOut } from '../db/messages-out.js';
import { getCurrentInReplyTo } from '../db/session-state.js';
import { getSessionRouting } from '../db/session-routing.js';
import { isAgentLane, sessionOwnsAChannel } from '../session-lane.js';
import { getAgentMailbox } from '../mailbox/index.js';
import { AGENT_DIR, OUTBOX_DIR } from '../roots.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Marks a `report_progress` note so the orchestrator can tell it from the
 * answer, and knows not to relay it.
 *
 * Carried in the TEXT rather than as a field on the content JSON, because the
 * orchestrator reads this through the ordinary formatter — `<message from=…>`
 * renders `content.text` and drops everything else, so a field would be
 * invisible at exactly the moment it has to be read.
 */
export const PROGRESS_PREFIX = '[progress — not the final answer, no need to relay]';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

/**
 * The thread of the last message this session received from that channel.
 *
 * The same mailbox operation `sendToDestination` uses in poll-loop.ts, and
 * deliberately so: the `<message to="...">` path has always threaded replies
 * correctly and this one has not, which made the two doors disagree about
 * where the same reply belongs.
 *
 * Failure is null rather than a throw. A missing thread posts at top level,
 * which a human sees at once; a throw would lose the message entirely.
 */
function latestInboundThread(channelType: string, platformId: string): string | null {
  try {
    return getAgentMailbox().operations.getLatestInboundRoute(channelType, platformId)?.threadId ?? null;
  } catch (error) {
    log(`latestInboundThread error: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Resolve a destination name to routing fields.
 *
 * Three answers for a channel destination, and the third is the one worth
 * explaining:
 *
 * 1. The destination IS the session's own channel — keep the session's
 *    thread, so a reply lands in the conversation it belongs to.
 * 2. A different channel, and the session has one of its own — null, because
 *    a cross-destination send starts a new conversation.
 * 3. A different channel, and the session has NO channel of its own — reuse
 *    the thread of the last message that channel sent us.
 *
 * WITHOUT (3) A GRANTED CHANNEL FRAGMENTS. An agent-lane session compares as
 * `channel_type: 'agent'` against every channel, so case 1 can never match and
 * case 2 sent every single reply top-level — a new thread per message, in a
 * conversation the agent itself opened. The thread binding cannot repair that
 * either: it is first-wins, so the first thread binds and every orphan after
 * it stays unbound.
 *
 * IT IS SCOPED TO SESSIONS WITH NO CHANNEL FOR A REASON, and widening it
 * would resurrect a bug that was already shipped and reverted. delivery.ts
 * once redirected every thread-less outbound into the session's bound thread
 * — "hook 3" — and it was removed: a `shared`-mode session's `thread_id` is
 * always null, every MCP tool copies that null onto its outbound, and the
 * binding is first-wins with nothing that clears it. So the first thread such
 * a session ever opened captured every later question card and proactive post
 * for the life of the session. A session that owns a channel therefore keeps
 * today's behaviour exactly, and that failure cannot return through this door.
 */
function resolveRouting(
  to: string,
): { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string } | { error: string } {
  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  const session = getSessionRouting();
  // A WORKER MAY NOT ADDRESS ITS OWN ORCHESTRATOR, and the row it would
  // address is deliberately left in place.
  //
  // `provision-agent.ts` grants every worker a `parent` destination, but not
  // so the worker can type it: the runner's automatic report is routed to the
  // orchestrator BY CODE, and that route passes the `a2a.send` guard, which
  // denies any pair with no destination row. The NAME is a side effect of
  // destinations being both the permission and the address.
  //
  // That side effect had a cost. A worker reports by simply writing its
  // answer — held in `pendingLaneReport`, superseded each turn, delivered ONCE
  // when the stream closes — and `send_message` bypasses all of it, delivering
  // immediately and as many times as it is called. A real run sent three
  // reports for one task, which is the running commentary the once-at-close
  // flush exists to prevent.
  //
  // Scoped to `isAgentLane`, NOT to "is an agent destination". A `create_agent`
  // companion has no lane — `workerOrchestratorGroup` returns null unless BOTH
  // `workspace_path` and `origin_session_id` are set, and `create_agent` leaves
  // both NULL — so `parent` is its ONLY way to reach its creator. Refusing
  // there would cut a companion off from the agent that made it.
  if (dest.type === 'agent' && isAgentLane(session) && dest.agentGroupId === session.platform_id) {
    return {
      error:
        `"${to}" is the agent that spawned you, and your replies already reach it. ` +
        `Write your answer as ordinary text — the runner delivers it when your turn ends. ` +
        `To say something mid-task use report_progress({text}); to ASK it something use ` +
        `ask_user_question, which blocks until it answers.`,
    };
  }
  if (dest.type === 'channel') {
    const isOwnChannel = session.channel_type === dest.channelType && session.platform_id === dest.platformId;
    let threadId: string | null = null;
    if (isOwnChannel) {
      threadId = session.thread_id;
    } else if (!sessionOwnsAChannel(session)) {
      threadId = latestInboundThread(dest.channelType!, dest.platformId!);
    }
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id: threadId,
      resolvedName: to,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}

export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description: 'Send a message to a named destination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Destination name (e.g., "family", "worker-1").',
        },
        text: { type: 'string', description: 'Message content' },
      },
      required: ['to', 'text'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const text = args.text as string;
    if (!to) return err(`to is required. Options: ${destinationList()}`);
    if (!text) return err('text is required');

    const routing = resolveRouting(to);
    if ('error' in routing) return err(routing.error);

    const id = generateId();
    const seq = await writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text }),
    });

    log(`send_message: #${seq} → ${routing.resolvedName}`);
    return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

export const sendFile: McpToolDefinition = {
  tool: {
    name: 'send_file',
    description: 'Send a file to a named destination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name.' },
        path: { type: 'string', description: 'File path (absolute, or relative to your working directory)' },
        text: { type: 'string', description: 'Optional accompanying message' },
        filename: { type: 'string', description: 'Display name (default: basename of path)' },
      },
      required: ['to', 'path'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const filePath = args.path as string;
    if (!to) return err(`to is required. Options: ${destinationList()}`);
    if (!filePath) return err('path is required');

    const routing = resolveRouting(to);
    if ('error' in routing) return err(routing.error);

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(AGENT_DIR, filePath);
    if (!fs.existsSync(resolvedPath)) return err(`File not found: ${filePath}`);

    const id = generateId();
    const filename = (args.filename as string) || path.basename(resolvedPath);

    const outboxDir = path.join(OUTBOX_DIR, id);
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.copyFileSync(resolvedPath, path.join(outboxDir, filename));

    await writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text: (args.text as string) || '', files: [filename] }),
    });

    log(`send_file: ${id} → ${routing.resolvedName} (${filename})`);
    return ok(`File sent to ${routing.resolvedName} (id: ${id}, filename: ${filename})`);
  },
};

export const editMessage: McpToolDefinition = {
  tool: {
    name: 'edit_message',
    description: 'Edit a previously sent message. Targets the same destination the original message was sent to.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        text: { type: 'string', description: 'New message content' },
      },
      required: ['messageId', 'text'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const text = args.text as string;
    if (!seq || !text) return err('messageId and text are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    await writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'edit', messageId: platformId, text }),
    });

    log(`edit_message: #${seq} → ${platformId}`);
    return ok(`Message edit queued for #${seq}`);
  },
};

export const addReaction: McpToolDefinition = {
  tool: {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        emoji: { type: 'string', description: 'Emoji name (e.g., thumbs_up, heart, check)' },
      },
      required: ['messageId', 'emoji'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const emoji = args.emoji as string;
    if (!seq || !emoji) return err('messageId and emoji are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    await writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'reaction', messageId: platformId, emoji }),
    });

    log(`add_reaction: #${seq} → ${emoji} on ${platformId}`);
    return ok(`Reaction queued for #${seq}`);
  },
};

/**
 * The cheap door to the orchestrator, opened because closing the wrong one is
 * only half a fix.
 *
 * A worker had exactly two ways to reach the agent that spawned it, and
 * neither fits "tell it something and keep working":
 *
 *   report   — automatic, and only at stream close. Cannot be used mid-task.
 *   ask      — `ask_user_question`, which BLOCKS for 600 s.
 *
 * So a worker with something to say mid-task and no question to ask had no
 * tool shaped for it, and reached for `send_message({to:"parent"})` — which
 * delivered immediately, as many times as it was called, defeating the
 * once-at-close flush. Refusing that name without providing this tool would
 * leave the same need with no outlet at all.
 *
 * Deliberately NOT a second report. The text is prefixed, so the orchestrator
 * can tell a progress note from the answer — which is the property
 * `pendingLaneReport` was introduced to protect, and the one an unmarked
 * mid-turn message destroys. The prefix also tells the orchestrator not to
 * relay it, so the human still sees one report per worker.
 */
export const reportProgress: McpToolDefinition = {
  tool: {
    name: 'report_progress',
    description:
      'Tell the agent that spawned you what you are doing, mid-task, without blocking and without ending your turn. ' +
      'Use it sparingly, for something it would want to know before you finish — a plan you have settled on, a ' +
      'surprise you hit, a long wait you are entering. It is NOT your answer: your answer is the ordinary text you ' +
      'write at the end of your turn, which reaches it automatically. Worker sessions only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description: 'What you are doing or what you found. One or two sentences.',
        },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    const text = ((args.text as string) || '').trim();
    if (!text) return err('text is required');

    const session = getSessionRouting();
    if (!isAgentLane(session)) {
      return err(
        'report_progress is for a worker reporting to the agent that spawned it. This session has a ' +
          `conversation of its own — use send_message({to, text}) instead. Destinations: ${destinationList()}`,
      );
    }

    const seq = await writeMessageOut({
      id: generateId(),
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: session.platform_id!,
      channel_type: session.channel_type!,
      thread_id: null,
      content: JSON.stringify({ text: `${PROGRESS_PREFIX} ${text}` }),
    });

    log(`report_progress: #${seq} → orchestrator`);
    return ok(`Progress reported (id: ${seq}). Keep working — this was not your answer.`);
  },
};

registerTools([sendMessage, sendFile, editMessage, addReaction, reportProgress]);
