/**
 * Which lane a session's own routing puts it on.
 *
 * `writeSessionRouting` (src/session-manager.ts) is the single discriminator in
 * the DATA: a session belonging to a chat routes to that channel and thread, a
 * session belonging to none routes down the agent lane as
 * `channel_type: 'agent'` with the spawning group as `platform_id`.
 *
 * The DECISION was not single. Four places asked it in three different ways —
 * `interactive.ts` twice, `core.ts`, `poll-loop.ts` — and two of those forms
 * disagree when `channel_type` is null, which is a real state (a mailbox the
 * host has never woken). Both files carrying the phrase "the single
 * discriminator" were describing the column, not themselves. These two
 * functions are the decision, once.
 *
 * THEY ARE NOT COMPLEMENTS, and that is deliberate rather than an oversight:
 * a session whose routing is missing entirely is on neither. `isAgentLane`
 * asks "can I speak to the agent that spawned me", which needs an address, so
 * it demands `platform_id`. `sessionOwnsAChannel` asks "is this conversation
 * mine to thread into", which a null `channel_type` answers no without needing
 * one. Anything relying on `!isAgentLane(r)` meaning "owns a channel" is
 * wrong for that third state, which is why neither is written as the negation
 * of the other.
 */

/** The shape both predicates read. Structural, so any routing row fits. */
export interface LaneRouting {
  channel_type: string | null;
  platform_id?: string | null;
}

/**
 * Is there no human at the other end — only the agent that spawned this one?
 *
 * True for a repo worker and for any other session the host created with no
 * messaging group. Requires the address as well as the marker, because every
 * caller uses the answer to SEND something.
 */
export function isAgentLane(routing: LaneRouting): boolean {
  return routing.channel_type === 'agent' && Boolean(routing.platform_id);
}

/**
 * Does this session have a channel of its own?
 *
 * Not a test for "am I a worker" — it is the test for "is any of this
 * conversation mine to thread into". A session with no routing at all answers
 * no, which is the safe reading: it threads nothing.
 */
export function sessionOwnsAChannel(routing: LaneRouting): boolean {
  return routing.channel_type !== null && routing.channel_type !== 'agent';
}
