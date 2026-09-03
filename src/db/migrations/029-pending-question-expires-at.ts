import type { DbDriver } from '../driver.js';
import { isDuplicateColumn } from '../errors.js';
import type { Migration } from './index.js';

/**
 * `expires_at` on `pending_questions` — when the tool that asked stops
 * listening.
 *
 * THE HOST CANNOT DERIVE THIS, and the two ways it tried both lose answers in
 * silence. It used to compare `created_at` against a copy of the container's
 * `ESCALATED_TIMEOUT_S`, which fails twice:
 *
 *   - `ask_user_question` takes a caller-supplied `timeout`. A worker asking
 *     with `timeout: 120` gave a 120s tool against a 600s host. An
 *     `answer_worker` at t=200s found an OPEN question, took the fast path,
 *     and wrote a `question_response` with nothing polling for it — filtered
 *     out by kind on every later poll, so the answer was destroyed while the
 *     tool had already told the model a late answer would arrive as a message.
 *   - Even with both constants equal, they start at different moments.
 *     `created_at` is stamped when DELIVERY processes the outbound row; the
 *     tool's clock started when it WROTE that row, at least one poll earlier.
 *     The host's window therefore always ended after the tool's, and anything
 *     landing in the gap was lost the same way.
 *
 * So the deadline now travels with the question, in the envelope the container
 * already sends for `title` and `options`, and this column is where it lands.
 * One clock, owned by the side that actually does the waiting.
 *
 * NULLABLE, and the two nulls mean different things. A channel-lane row has no
 * deadline at all — a card waits for a person to click it, with nothing
 * expiring it — and `getOpenQuestionForAgentGroup` never returns those rows
 * anyway. An escalated row written by an older container predates the envelope
 * field, so the reader falls back to `created_at` plus the historical bound.
 * The fallback is deliberately the OLD behaviour rather than a refusal: those
 * rows are answerable, just imprecisely, and refusing them would strand a
 * worker mid-upgrade.
 *
 * The container is expected to send an instant slightly EARLIER than the one
 * it truly waits until, because it computes the value before writing the row.
 * That direction is the safe one: the host degrades to an ordinary message
 * while the tool is still listening, so the answer is delivered as prose and
 * the tool times out. The opposite skew is the one that loses it.
 *
 * Idempotent per column for the same reason as migration 028, and a caught
 * error rather than a `PRAGMA` lookup because migrations past the portability
 * boundary must run on any driver.
 */
async function addColumnIfMissing(db: DbDriver, table: string, column: string): Promise<void> {
  try {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err;
  }
}

export const migration029: Migration = {
  version: 29,
  name: 'pending-question-expires-at',
  async up(db) {
    await addColumnIfMissing(db, 'pending_questions', 'expires_at');
  },
};
