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
  const row = getAgentMailbox().operations.getState(IN_REPLY_TO_KEY);
  if (!row) return null;
  const age = Date.now() - new Date(row.updatedAt).getTime();
  if (!Number.isFinite(age) || age > IN_REPLY_TO_MAX_AGE_MS) return null;
  return row.value;
}

/**
 * The escalated question this session is blocked on, and the answer to it.
 *
 * These two keys are how a WAITING MCP TOOL and the POLL LOOP find each other.
 * They cannot share a variable: the MCP server is a separate stdio subprocess,
 * which is the same reason `current_in_reply_to` lives here rather than in
 * module state.
 *
 * The handshake, in order:
 *
 *   1. `ask_user_question` on the agent lane sends the question to the
 *      orchestrator and sets `open_question` to its id, then polls
 *      `takeQuestionAnswer`.
 *   2. The poll loop's follow-up poller sees `open_question` set and a new
 *      inbound message. It writes the message's text as the answer and clears
 *      `open_question` — and does NOT push the message into the live query.
 *   3. The tool takes the answer and returns it as its own result.
 *
 * STEP 2's "does not push" is the whole point. The poller's ordinary job is to
 * feed inbound messages to the model mid-turn; do that here and the model is
 * handed an answer while it is still blocked inside the tool that asked for
 * it, and the tool then times out having never seen it. Same message, two
 * doors, and only one of them reaches a model that can act on it.
 */
const OPEN_QUESTION_KEY = 'open_question';
const QUESTION_ANSWER_KEY = 'question_answer';

/**
 * Ignore a question older than this — the same shape of guard as
 * `IN_REPLY_TO_MAX_AGE_MS`, and needed for the same reason: a container
 * SIGKILLed while a tool was waiting leaves the key behind, and a stale
 * `open_question` would silently swallow the next ordinary message the
 * orchestrator sends. Comfortably longer than any tool's own bound, so it
 * never expires a question that is still being waited on.
 */
const OPEN_QUESTION_MAX_AGE_MS = 30 * 60 * 1000;

export function setOpenQuestion(questionId: string): void {
  setValue(OPEN_QUESTION_KEY, questionId);
}

export function clearOpenQuestion(): void {
  deleteValue(OPEN_QUESTION_KEY);
}

/** The id of the question this session is blocked on, if any is still live. */
export function getOpenQuestion(): string | null {
  const row = getAgentMailbox().operations.getState(OPEN_QUESTION_KEY);
  if (!row) return null;
  const age = Date.now() - new Date(row.updatedAt).getTime();
  if (!Number.isFinite(age) || age > OPEN_QUESTION_MAX_AGE_MS) return null;
  return row.value;
}

/** Hand an answer to the tool waiting on `questionId`, and close the question. */
export function setQuestionAnswer(questionId: string, answer: string): void {
  setValue(QUESTION_ANSWER_KEY, JSON.stringify({ questionId, answer }));
  deleteValue(OPEN_QUESTION_KEY);
}

/**
 * Take the answer to `questionId`, if it has arrived. Consuming: a second call
 * returns undefined, so a late poll cannot re-deliver an answer the tool has
 * already returned.
 *
 * An answer for a DIFFERENT question is left in place rather than dropped —
 * it belongs to whoever asked that one.
 */
export function takeQuestionAnswer(questionId: string): string | undefined {
  const raw = getValue(QUESTION_ANSWER_KEY);
  if (!raw) return undefined;
  let parsed: { questionId?: string; answer?: string };
  try {
    parsed = JSON.parse(raw) as { questionId?: string; answer?: string };
  } catch {
    // Unparseable is unusable; drop it so it cannot block every later answer.
    deleteValue(QUESTION_ANSWER_KEY);
    return undefined;
  }
  if (parsed.questionId !== questionId) return undefined;
  deleteValue(QUESTION_ANSWER_KEY);
  return parsed.answer ?? '';
}
