import type { DbDriver } from '../driver.js';
import { isDuplicateColumn } from '../errors.js';
import type { Migration } from './index.js';

/**
 * `bound_messaging_group_id` + `bound_root_message_id` on `sessions` — the
 * thread a session OPENED.
 *
 * A session posts into a channel with no `thread_id`. The channel turns that
 * post into a thread, and its message id becomes the thread's root. Nothing
 * recorded that, so a reply arriving on the new thread matched no session:
 * `resolveSession` keys on (agent group, messaging group, thread), the thread
 * had never been seen, and a BRAND NEW session answered in a conversation it
 * knew nothing about — with an empty transcript, while the session that
 * actually opened the thread was never told.
 *
 * These two columns are that missing note. One writer
 * (`bindSessionToThread`, at delivery) and two readers:
 * `findSessionBoundToThread` on the inbound path, `findSessionThreadBinding`
 * on the outbound one.
 *
 * ONE BINDING PER SESSION, deliberately. A pair of columns cannot hold two, so
 * a session that opens a top-level post in a SECOND channel leaves that thread
 * unbound, and replies there still mint a new session. A separate table would
 * lift that, and the day a real case appears it is the migration to write. It
 * is not written now because the shape that already exists covers the case
 * that actually happens: one cross-channel post per conversation.
 *
 * NO UNIQUE CONSTRAINT, also deliberately. The obvious guard would be
 * `UNIQUE(bound_messaging_group_id, bound_root_message_id)` to settle a race
 * between two binders. There is no such race: `drainSession` awaits one
 * message at a time, `inflightDeliveries` rejects a second poll chain on the
 * same session, and a root message is created by exactly one delivery. A
 * constraint against an impossible collision would only convert a future
 * schema surprise into a failed write.
 *
 * IDEMPOTENT PER COLUMN, because the columns may already be there. A reverted
 * branch's migration added these same two, and installs that ran it still
 * carry the columns while its `schema_version` row names a migration this
 * code no longer has. The runner treats an applied-but-absent migration as
 * nothing to do, so THIS migration — a different name — does run there,
 * against a table that already has the columns. A bare `ALTER` would throw
 * `duplicate column name` and stop startup.
 *
 * The check is a caught error rather than a `pragma_table_info` lookup:
 * migrations after the portability boundary must run on any driver, and
 * `PRAGMA` is banned from them (`portability.test.ts`).
 */
async function addColumnIfMissing(db: DbDriver, table: string, column: string): Promise<void> {
  try {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err;
  }
}

export const migration028: Migration = {
  version: 28,
  name: 'session-thread-bindings',
  async up(db) {
    await addColumnIfMissing(db, 'sessions', 'bound_messaging_group_id');
    await addColumnIfMissing(db, 'sessions', 'bound_root_message_id');
    // The inbound lookup runs on every message that carries a thread, so it is
    // the hot one. Partial, because only a handful of sessions are ever bound
    // and an unbound row has nothing to offer this index.
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_bound_thread
         ON sessions(bound_messaging_group_id, bound_root_message_id)
       WHERE bound_messaging_group_id IS NOT NULL`,
    );
  },
};
