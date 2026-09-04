/**
 * Thread-history seeding — the platform half of new-session context.
 *
 * backfill.ts seeds a new session from SIBLING sessions, so it can only
 * surface what nanoclaw already stored. Three things defeat that, and all
 * three were measured on a live install:
 *  - the messaging group was wired AFTER the thread started, so the earlier
 *    messages never reached the host at all,
 *  - the wiring drops non-engaging messages, so nothing was accumulated,
 *  - the thread is the conversation's first, so there are no siblings.
 * In each case an agent tagged mid-thread answers from nothing. Measured: 9
 * of 25 threads that mention the agent tag it mid-thread, with up to 12
 * messages already posted.
 *
 * So we ask the platform. At session birth the adapter reads the thread's
 * own earlier messages and they are written as trigger=0 session-echo rows
 * BEFORE the triggering message, giving them a lower seq — the container
 * formatter then renders them as the prelude to the live turn.
 *
 * Blueprint: kttran-wego/blueprints#6, approved 2026-09-04. Round 1 settled
 * that thread membership, not agent-group membership, is the gate here: any
 * message in the thread is context, so this path applies no access filter.
 * The live accumulate path still gates on membership, which is a deliberate
 * asymmetry recorded as that blueprint's open question.
 */
import { isTaskThread } from '../../db/sessions.js';
import { log } from '../../log.js';
import { withExistingMailboxSession, writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent, Session } from '../../types.js';
import type { ThreadHistoryMessage } from '../../channels/adapter.js';
import { ECHO_CHANNEL_TIMELINE_SURFACE, ECHO_CHANNEL_TYPE, ECHO_TIMELINE_SURFACE } from './config.js';
import { truncateEchoText } from './fan.js';

/** Matches BACKFILL_LIMIT, and the measured p90 of 12 preceding messages. */
export const THREAD_HISTORY_LIMIT = 12;

/** A platform read must never hold up delivery of the triggering message. */
export const THREAD_HISTORY_FETCH_TIMEOUT_MS = 4000;

/**
 * The entry a short mention ("do this") is usually answering. Delivered
 * whole, as backfill.ts does for the same reason.
 */
const LAST_ENTRY_MAX_CHARS = 4000;

/**
 * The one channel capability this module needs.
 *
 * A function rather than the adapter itself, for the same reason
 * `toLocalMessageId` is a function: the module names what it uses, not who
 * provides it, and so inherits no change to the 18-member delivery port.
 */
export type ThreadHistoryReader = (
  platformId: string,
  threadId: string,
  limit: number,
) => Promise<ThreadHistoryMessage[]>;

export interface SeedThreadHistoryInput {
  agentGroup: AgentGroup;
  session: Session;
  mg: MessagingGroup;
  /** Absent means the channel cannot read history. Seeding no-ops. */
  readThreadHistory: ThreadHistoryReader | undefined;
  platformId: string;
  threadId: string | null;
  /**
   * The wiring's policy for messages that do not engage the agent. 'drop' is
   * the operator asking for no ambient context between mentions, so reading
   * the same messages off the platform would defeat the setting they chose.
   */
  ignoredMessagePolicy: MessagingGroupAgent['ignored_message_policy'];
  /** Platform id of the mention that created this session. Never re-seeded. */
  triggerMessageId: string | undefined;
  /**
   * Maps a platform message id to the id the router would store it under.
   * Passed in rather than imported so the id scheme stays owned by the
   * router, and this module keeps depending inward.
   */
  toLocalMessageId: (platformMessageId: string) => string;
}

/**
 * Row id for a seeded history message.
 *
 * Namespaced by session so the same platform message can seed sibling
 * sessions without colliding on the messages_in primary key.
 */
export function threadHistoryRowId(platformMessageId: string, sessionId: string): string {
  return `${platformMessageId}:threadhist:${sessionId}`;
}

/**
 * Read the thread's earlier messages, or return none.
 *
 * Resolves to an empty array for every failure — a missing capability, a
 * task thread, a rejected call, or a slow platform. The caller then writes
 * no prelude and the triggering message is delivered as it is today.
 */
async function fetchThreadMessages(input: SeedThreadHistoryInput): Promise<ThreadHistoryMessage[]> {
  const { readThreadHistory, session, threadId, platformId, ignoredMessagePolicy } = input;
  if (!readThreadHistory) return [];
  if (ignoredMessagePolicy !== 'accumulate') return [];
  if (threadId === null) return [];
  if (isTaskThread(threadId)) return [];

  const fetching = readThreadHistory(platformId, threadId, THREAD_HISTORY_LIMIT).catch(
    (err: unknown): ThreadHistoryMessage[] => {
      log.warn('Thread-history fetch failed (continuing without context)', { sessionId: session.id, err });
      return [];
    },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiring = new Promise<ThreadHistoryMessage[]>((resolve) => {
    timer = setTimeout(() => {
      log.warn('Thread-history fetch timed out (continuing without context)', { sessionId: session.id });
      resolve([]);
    }, THREAD_HISTORY_FETCH_TIMEOUT_MS);
  });

  try {
    return await Promise.race([fetching, expiring]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Drop the messages this session already holds.
 *
 * The triggering mention goes in moments later as the trigger=1 row, and the
 * accumulate path may already have stored earlier ones. Both are matched by
 * exact primary key, so no text comparison is involved.
 */
async function selectUnseen(
  input: SeedThreadHistoryInput,
  messages: ThreadHistoryMessage[],
): Promise<ThreadHistoryMessage[]> {
  const { agentGroup, session, triggerMessageId, toLocalMessageId } = input;
  const candidates = messages.filter((m) => m.id !== triggerMessageId);
  if (candidates.length === 0) return [];

  const seen = await withExistingMailboxSession(agentGroup.id, session.id, (mailbox) => {
    const ids = new Set<string>();
    for (const message of candidates) {
      const stored =
        mailbox.hasMessage(toLocalMessageId(message.id)) ||
        mailbox.hasMessage(threadHistoryRowId(message.id, session.id));
      if (stored) ids.add(message.id);
    }
    return ids;
  });

  return seen ? candidates.filter((m) => !seen.has(m.id)) : candidates;
}

async function writeHistoryRows(input: SeedThreadHistoryInput, rows: ThreadHistoryMessage[]): Promise<void> {
  const { agentGroup, session, mg } = input;
  const surface = mg.is_group === 1 ? ECHO_CHANNEL_TIMELINE_SURFACE : ECHO_TIMELINE_SURFACE;
  const label = 'this thread, before the agent was brought in';

  for (const [index, row] of rows.entries()) {
    const isLast = index === rows.length - 1;
    await writeSessionMessage(agentGroup.id, session.id, {
      id: threadHistoryRowId(row.id, session.id),
      kind: 'chat',
      timestamp: row.timestamp,
      channelType: ECHO_CHANNEL_TYPE,
      content: JSON.stringify({
        text: isLast ? row.text.slice(0, LAST_ENTRY_MAX_CHARS) : truncateEchoText(row.text),
        sender: row.sender,
        senderId: row.senderId,
        ...(row.self ? { self: true } : {}),
        echo: { surface, label },
      }),
      trigger: false,
    });
  }
}

/**
 * Seed a just-created thread session with the thread's own earlier messages.
 *
 * Call BEFORE the triggering message is written, so the prelude takes a lower
 * seq. Non-throwing: any failure leaves the session with no prelude rather
 * than losing the message that created it.
 */
export async function seedThreadHistory(input: SeedThreadHistoryInput): Promise<void> {
  try {
    const messages = await fetchThreadMessages(input);
    if (messages.length === 0) return;

    const unseen = await selectUnseen(input, messages);
    if (unseen.length === 0) return;

    await writeHistoryRows(input, unseen);
    log.debug('Seeded new session with thread history', {
      sessionId: input.session.id,
      fetched: messages.length,
      written: unseen.length,
    });
  } catch (err) {
    log.warn('Thread-history seeding failed (continuing without context)', {
      sessionId: input.session.id,
      err,
    });
  }
}
