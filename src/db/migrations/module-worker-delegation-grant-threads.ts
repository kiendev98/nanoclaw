import type { DbDriver } from '../driver.js';
import { qualifiedThreadId } from '../../platform-id.js';
import type { ModuleMigration } from './index.js';

/**
 * Rewrite every lent-conversation thread id into the shape its adapter
 * addresses.
 *
 * `bindLentConversationThread` stored the raw id the platform returned for the
 * root post, and a Chat SDK adapter refuses that id because it decodes one it
 * never encoded. Observed: three delivery attempts, then a permanent drop.
 *
 * A migration, not a read-time repair. The column feeds three readers — session
 * routing, the inbound thread lookup, and the bot-admission exemption — and a
 * repair in each would keep both shapes legal for good, which is how the two
 * came to coexist unnoticed. One shape in the column leaves one write site to
 * get right.
 *
 * A live grant carries the old shape into the session routing projected before
 * this ran. That projection is rewritten when the worker's container next
 * spawns, and migrations run before any container starts.
 *
 * The rule comes from `qualifiedThreadId`, so this migration and the write site
 * can never disagree. It runs the rule per row rather than in SQL, because the
 * rule reads one row against another column of the same row.
 */
export const moduleWorkerDelegationGrantThreads = {
  version: 26,
  name: 'module:worker-delegation:grant-thread-ids',
  sqliteOnly: false,
  async up(db: DbDriver) {
    const grants = await db.all<{ task_id: string; platform_id: string; thread_id: string }>(
      "SELECT task_id, platform_id, thread_id FROM worker_channel_grants WHERE thread_id <> ''",
    );
    for (const grant of grants) {
      const qualified = qualifiedThreadId(grant.platform_id, grant.thread_id);
      if (qualified === grant.thread_id) continue;
      await db.run('UPDATE worker_channel_grants SET thread_id = ? WHERE task_id = ?', qualified, grant.task_id);
    }
  },
} satisfies ModuleMigration;
