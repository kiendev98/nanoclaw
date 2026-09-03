/**
 * Persistent key/value state owned by the registered mailbox.
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getAgentMailbox } from '../mailbox/index.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  return getAgentMailbox().operations.getState(key)?.value;
}

function setValue(key: string, value: string): void {
  getAgentMailbox().operations.setState(key, value);
}

function deleteValue(key: string): void {
  getAgentMailbox().operations.deleteState(key);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

/**
 * Footer telemetry, as one JSON blob.
 *
 * Persisted because the numbers arrive far more rarely than they are read.
 * `contextWindow` is reported once per turn on the result, and a
 * `rate_limit_event` fires ONLY when a utilization changes — which can be
 * many turns apart. Sessions are swept whenever they go idle, so in-memory
 * state means every wake starts blank and the footer shows a bare model name
 * until the SDK happens to mention those numbers again.
 *
 * Kept as an opaque string here so this module stays a key/value store and
 * the shape belongs to `message-footer.ts`.
 */
const FOOTER_TELEMETRY_KEY = 'footer_telemetry';

export function getFooterTelemetry(): string | undefined {
  return getValue(FOOTER_TELEMETRY_KEY);
}

export function setFooterTelemetry(json: string): void {
  setValue(FOOTER_TELEMETRY_KEY, json);
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}
/**
 * Read a key, treating anything older than `maxAgeMs` as absent.
 *
 * Every key here is written by one process and read by another, and none of
 * them survives the container that wrote it. A SIGKILL leaves whatever was set
 * behind, so each reader needs an age bound — this is that bound, once,
 * instead of once per key.
 *
 * @param maxAgeMs How recently the key must have been written to count.
 * @returns The stored value, or null when the key is missing, unparseable, or
 *   too old.
 */
function getFresh(key: string, maxAgeMs: number): string | null {
  const row = getAgentMailbox().operations.getState(key);
  if (!row) return null;
  const age = Date.now() - new Date(row.updatedAt).getTime();
  if (!Number.isFinite(age) || age > maxAgeMs) return null;
  return row.value;
}


/**
 * The a2a reply stamp: the id of the first inbound message in the batch the
 * agent is currently processing. The poll loop publishes it at batch start;
 * MCP tools (`send_message`, `send_file`) read it and stamp it onto outbound
 * rows so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * This lives in mailbox state because the MCP server runs as a separate stdio
 * subprocess; module state set by the poll loop is invisible to it.
 */
const IN_REPLY_TO_KEY = 'current_in_reply_to';

/**
 * Ignore a stamp older than this. The poll loop clears the stamp in a
 * finally, but a container killed mid-batch (SIGKILL) can leave one behind;
 * the guard stops a later out-of-batch read from picking up a dead stamp.
 * Generous so a long-running batch's late sends still stamp correctly.
 */
const IN_REPLY_TO_MAX_AGE_MS = 30 * 60 * 1000;

export function setCurrentInReplyTo(id: string | null): void {
  if (id === null) {
    clearCurrentInReplyTo();
    return;
  }
  setValue(IN_REPLY_TO_KEY, id);
}

export function clearCurrentInReplyTo(): void {
  deleteValue(IN_REPLY_TO_KEY);
}

export function getCurrentInReplyTo(): string | null {
  return getFresh(IN_REPLY_TO_KEY, IN_REPLY_TO_MAX_AGE_MS);
}


/**
 * Whether an MCP tool is currently blocked waiting for an inbound message.
 *
 * ONE ABSTRACT FACT, deliberately. The poll loop needs to know only "do not
 * push this tick"; it does not need the question id, the answer envelope, or
 * the rule for which message counts. That knowledge belongs to the tool, and
 * an earlier revision that put it in the poll loop had to store the answer in
 * a second key for the tool to collect.
 *
 * That second key was a mailbox with no proof its reader still existed. A
 * container SIGKILLed mid-wait left the flag set for its full lifetime, and
 * the poll loop would then consume and ACK the next ordinary message into a
 * slot nobody was polling — a message destroyed with no trace. There is no
 * such slot now: the tool claims its own answer through `processing_ack`, so
 * if the tool is gone nobody claims the row and it is delivered normally.
 *
 * WHAT MAKES THE FLAG SAFE IS THAT IT IS SHORT-LIVED. The waiting tool
 * refreshes it on every poll iteration, so "fresh" means a tool was alive
 * within the last few seconds — not merely that one started waiting at some
 * point in the last half hour. A dead waiter's flag expires in seconds.
 */
const AWAITING_INBOUND_KEY = 'awaiting_inbound';

/**
 * How stale the flag may be before the poll loop ignores it.
 *
 * Comfortably more than the 1s refresh interval, so an ordinary scheduling
 * delay never looks like a dead waiter, and small enough that a killed
 * container withholds at most one poll tick.
 */
const AWAITING_INBOUND_MAX_AGE_MS = 3_000;

/**
 * Say "still waiting" — call once per poll iteration, not once per wait.
 *
 * @param questionId Stored as the value for the log trail only; freshness is
 *   read from the row's own `updatedAt`.
 */
export function markAwaitingInbound(questionId: string): void {
  setValue(AWAITING_INBOUND_KEY, questionId);
}

export function clearAwaitingInbound(): void {
  deleteValue(AWAITING_INBOUND_KEY);
}

/** True while a tool is blocked waiting for an inbound message to claim. */
export function isToolAwaitingInbound(): boolean {
  return getFresh(AWAITING_INBOUND_KEY, AWAITING_INBOUND_MAX_AGE_MS) !== null;
}
