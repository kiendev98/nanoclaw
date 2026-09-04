/**
 * Threads a feature has claimed as a sanctioned bot-to-bot loop.
 *
 * A channel's bot-admission policy counts consecutive bot turns and stops at a
 * cap that only a human resets, which is the only thing standing between two
 * agents and an infinite loop. Some loops are deliberate — an agent driving a
 * review with another agent — and stopping one mid-conversation leaves nothing
 * but a log line.
 *
 * So a feature that OWNS such a loop claims its thread here, and the channel
 * asks. The exemption is per thread, never a higher cap: every other room keeps
 * the bound. The direction matters more than the mechanism — a domain module
 * naming a channel adapter would tie a trunk feature to a file that ships as a
 * skill payload, and a build without that skill would not compile.
 *
 * A claim lives in memory, so a host restart re-arms the cap on a thread that
 * was exempt. That fails toward the bound rather than away from it.
 */
import { log } from '../log.js';

/** Answers whether one thread is a claimed loop. Must not throw, and must not block. */
export type ExemptThreadQuery = (channelType: string, platformId: string, threadId: string) => boolean;

const queries: ExemptThreadQuery[] = [];

export function registerExemptThreadQuery(query: ExemptThreadQuery): void {
  queries.push(query);
}

/**
 * True when any registered feature claims this thread.
 *
 * A throwing query answers "not exempt", so a broken claimant tightens the cap
 * rather than removing it.
 */
export function isThreadExempt(channelType: string, platformId: string, threadId: string): boolean {
  return queries.some((query) => {
    try {
      return query(channelType, platformId, threadId);
    } catch (err) {
      log.warn('Thread-exemption query threw — treating the thread as not exempt', { channelType, err });
      return false;
    }
  });
}

/** Test seam. Registration is by import side effect, so a suite needs a way back. */
export function _clearExemptThreadQueriesForTesting(): void {
  queries.length = 0;
}
