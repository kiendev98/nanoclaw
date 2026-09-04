/**
 * Thread-history seeding — the platform half of new-session context.
 *
 * backfill.ts seeds a new session from SIBLING sessions, so it can only
 * surface what nanoclaw already stored. An agent tagged mid-thread therefore
 * answers from nothing whenever the thread's own earlier messages never
 * reached us — the messaging group was wired after the thread started, the
 * host was down, or every earlier sender was refused by the access gate.
 * Measured: 9 of 25 threads that mention the agent tag it mid-thread, with up
 * to 12 messages already posted.
 *
 * One condition narrows the reach, and it is the right one: seeding runs only
 * when the mention CREATED the session. If the thread's earlier messages did
 * reach us, they created the session already and their content is in it, so
 * there is nothing to fetch.
 *
 * It is NOT gated on the wiring's ignored-message policy. That gate was tried
 * and removed, because it excluded the feature's own best case. A 'drop'
 * wiring discards non-engaging messages, so a thread there NEVER creates a
 * session until the mention arrives — which is exactly when seeding fires and
 * exactly when nothing local exists to fall back on. 'drop' also being the
 * schema default meant a fresh install got nothing at all.
 *
 * The policy governs ambient chatter the agent was never asked about. This is
 * the context of a message it WAS asked to answer, which is a different
 * question, and the approver answered it: any message in the thread is
 * context. See the blueprint below.
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
import { withExistingMailboxSession } from '../../session-manager.js';
import type { MessagePresence } from '../../mailbox/types.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';
import type { ThreadHistoryMessage } from '../../channels/adapter.js';
import { preludeSurface, writePreludeRows } from './prelude.js';

/**
 * How many earlier messages to seed.
 *
 * Nine, not the measured p90 of twelve, because the container reads at most
 * `maxMessagesPerPrompt` rows per turn — ten by default — and gives the
 * triggering message a slot first. Seeding twelve leaves the three OLDEST
 * pending, and they surface on a later turn as fresh prelude: the start of
 * the thread arriving after the agent already answered from the end of it.
 * Nine is the largest batch the default cap reads in one turn, and the newest
 * nine are the relevant ones.
 */
export const THREAD_HISTORY_LIMIT = 9;

/**
 * A platform read must never hold up delivery of the triggering message.
 *
 * Generous because the Slack adapter enriches per fetched message: a
 * `users.info` lookup for each uncached author, plus a wait of up to two
 * seconds for an un-unfurled link. Four seconds was inside that envelope, so
 * a normal thread could time out and lose its prelude with only a warn line.
 */
export const THREAD_HISTORY_FETCH_TIMEOUT_MS = 8000;

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
  /** Platform id of the mention that created this session. Never re-seeded. */
  triggerMessageId: string | undefined;
  /**
   * ISO send time of that mention. Anything not strictly older is a message
   * that landed while the fetch was in flight, and it arrives as its own
   * inbound row — seeding it too would put the same text in the prompt twice.
   */
  triggerTimestamp: string;
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
  const { readThreadHistory, session, threadId, platformId } = input;
  if (!readThreadHistory) return [];
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
  const { agentGroup, session, triggerMessageId, triggerTimestamp, toLocalMessageId } = input;
  const candidates = messages.filter((m) => m.id !== triggerMessageId && m.timestamp < triggerTimestamp);
  if (candidates.length === 0) return [];

  // Narrowed to the one capability used, so the type states the dependency
  // even though the helper hands over a whole mailbox.
  const seen = await withExistingMailboxSession(agentGroup.id, session.id, (mailbox: MessagePresence) => {
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

async function writeHistoryRows(input: SeedThreadHistoryInput, rows: ThreadHistoryMessage[]): Promise<number> {
  const { agentGroup, session, mg } = input;
  return await writePreludeRows(agentGroup.id, session.id, rows, {
    surface: preludeSurface(mg),
    label: 'this thread, before the agent was brought in',
    rowId: (row) => threadHistoryRowId(row.id, session.id),
  });
}

/**
 * Seed a just-created thread session with the thread's own earlier messages.
 *
 * Call BEFORE the triggering message is written, so the prelude takes a lower
 * seq. Non-throwing: any failure leaves the session with no prelude rather
 * than losing the message that created it.
 *
 * @returns How many rows were written. Zero means the caller may fall back to
 *   another prelude source — the container caps how many context rows reach
 *   one prompt, so two preludes would leave one of them written and unread.
 */
export async function seedThreadHistory(input: SeedThreadHistoryInput): Promise<number> {
  try {
    const messages = await fetchThreadMessages(input);
    if (messages.length === 0) return 0;

    // Clamp on the write side. `limit` is a request, and the SDK notes each
    // adapter has its own default page size — an adapter that treats it as
    // advisory must not be able to fill the mailbox with pending echo rows.
    const unseen = (await selectUnseen(input, messages)).slice(-THREAD_HISTORY_LIMIT);
    if (unseen.length === 0) return 0;

    const written = await writeHistoryRows(input, unseen);
    log.debug('Seeded new session with thread history', {
      sessionId: input.session.id,
      fetched: messages.length,
      written,
    });
    return written;
  } catch (err) {
    log.warn('Thread-history seeding failed (continuing without context)', {
      sessionId: input.session.id,
      err,
    });
    return 0;
  }
}
