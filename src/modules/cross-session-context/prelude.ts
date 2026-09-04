/**
 * The prelude-row writer — one wire contract, two collectors.
 *
 * A new session is seeded with context from two independent sources:
 * backfill.ts collects the top-level timeline of SIBLING sessions from our own
 * mailboxes, and thread-history.ts asks the platform for THIS thread's earlier
 * messages. Different sources, identical output — trigger=0 session-echo rows
 * the container formatter parses as `<channel-history>` / `<dm-history>`.
 *
 * That envelope had grown three writers, and the drift had started: the
 * last-entry allowance was a named constant in one file and a bare 4000 in
 * another. So the shape and the last-entry rule live here, once, while each
 * caller keeps what is genuinely its own — how it collects rows, how it names
 * them, and what label describes where they came from.
 *
 * fan.ts deliberately stays out. Its live echoes carry no `self` field and no
 * last-entry rule, so folding it in would need a flag per caller — which is
 * where duplication beats the abstraction.
 */
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup } from '../../types.js';
import { ECHO_CHANNEL_TIMELINE_SURFACE, ECHO_CHANNEL_TYPE, ECHO_TIMELINE_SURFACE } from './config.js';
import { truncateEchoText } from './fan.js';

/**
 * The newest entry is what a short opener ("sure", "do this") answers, so it
 * is delivered whole. Earlier entries take the normal echo cap.
 *
 * "Newest" means the last row of the batch handed to `writePreludeRows`. That
 * is the newest in the session too, because the router seeds from one source
 * per session — never both.
 */
export const LAST_ENTRY_MAX_CHARS = 4000;

/** The fields every prelude source supplies, whatever it collected them from. */
export interface PreludeRow {
  timestamp: string;
  sender: string;
  senderId: string;
  text: string;
  /** Authored by the agent itself. The formatter renders these as "you". */
  self: boolean;
}

export interface PreludeMeta<T extends PreludeRow> {
  /** Wire surface the formatter switches on. Use `preludeSurface`. */
  surface: string;
  /** Human phrase telling the agent where these rows came from. */
  label: string;
  /** Row id, which each caller namespaces its own way. */
  rowId: (row: T, index: number) => string;
}

/**
 * Group surfaces can be per-thread just like DMs, so both are seeded with a
 * timeline. Same messaging group means the same audience either way.
 */
export function preludeSurface(mg: MessagingGroup): string {
  return mg.is_group === 1 ? ECHO_CHANNEL_TIMELINE_SURFACE : ECHO_TIMELINE_SURFACE;
}

/**
 * Write ordered prelude rows as trigger=0 echoes.
 *
 * Rows are written in the order given, so each takes the next `seq`. Call
 * BEFORE the triggering message, which then sorts after the whole prelude.
 *
 * @param rows Chronological, oldest first. The last is treated as newest.
 * @returns How many rows reached the mailbox. A caller that decides whether to
 *   write a second prelude must branch on this and not on whether the call
 *   threw: a throw partway through still leaves the earlier rows written, and
 *   treating that as "nothing written" produces the double prelude the
 *   per-prompt cap cannot absorb.
 */
export async function writePreludeRows<T extends PreludeRow>(
  agentGroupId: string,
  sessionId: string,
  rows: T[],
  meta: PreludeMeta<T>,
): Promise<number> {
  // The row timestamp is when this row was SEEDED, not when the message was
  // sent. The echo pruner drops pending rows older than ECHO_MAX_AGE_DAYS by
  // this column, and a thread wired weeks after it started — the case thread
  // history exists for — would have its whole prelude swept before the
  // container's first poll. The true send time rides in echo.sentAt, which is
  // what the formatter displays.
  const seededAt = new Date().toISOString();
  let written = 0;
  for (const [index, row] of rows.entries()) {
    const isLast = index === rows.length - 1;
    try {
      await writeSessionMessage(agentGroupId, sessionId, {
        id: meta.rowId(row, index),
        kind: 'chat',
        timestamp: seededAt,
        channelType: ECHO_CHANNEL_TYPE,
        content: JSON.stringify({
          text: isLast ? row.text.slice(0, LAST_ENTRY_MAX_CHARS) : truncateEchoText(row.text),
          sender: row.sender,
          senderId: row.senderId,
          ...(row.self ? { self: true } : {}),
          echo: { surface: meta.surface, label: meta.label, sentAt: row.timestamp },
        }),
        trigger: false,
      });
    } catch (err) {
      // Stop rather than press on, and report what did land. A caller that
      // reads zero writes a second prelude, which the per-prompt cap cannot
      // absorb — so a partial write must never look like no write.
      log.warn('Prelude row write failed (keeping the rows already seeded)', {
        sessionId,
        written,
        remaining: rows.length - index,
        err,
      });
      return written;
    }
    written += 1;
  }
  return written;
}
