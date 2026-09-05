import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../connection.js';
import { runMigrations } from './index.js';
import { moduleWorkerDelegation } from './module-worker-delegation.js';
import { moduleWorkerDelegationGrantThreads } from './module-worker-delegation-grant-threads.js';
import type { DbDriver } from '../driver.js';

const NOW = new Date().toISOString();

let db: DbDriver;

async function seedGrant(taskId: string, platformId: string, threadId: string): Promise<void> {
  await db.run(
    `INSERT INTO worker_channel_grants (
       task_id, helper_agent_group_id, helper_session_id, messaging_group_id, channel_type,
       platform_id, root_message_id, thread_id, local_destination_name, granted_by_session_id,
       granted_at, released_at
     ) VALUES (?, 'ag-worker', 'sess-worker', 'mg-lent', 'slack', ?, ?, ?, 'conversation', 'sess-principal', ?, NULL)`,
    taskId,
    platformId,
    `wlend-${taskId}`,
    threadId,
    NOW,
  );
}

async function threadIdOf(taskId: string): Promise<string | undefined> {
  const row = await db.get<{ thread_id: string }>(
    'SELECT thread_id FROM worker_channel_grants WHERE task_id = ?',
    taskId,
  );
  return row?.thread_id;
}

beforeEach(async () => {
  db = await initTestDb();
  await runMigrations(db, [moduleWorkerDelegation]);
});

afterEach(async () => {
  await closeDb();
});

describe('module:worker-delegation:grant-thread-ids', () => {
  it('qualifies a thread id that was stored as a raw message id', async () => {
    await seedGrant('wt-bare', 'slack:C0BU6RSGAGK', '1788596827.545309');

    await moduleWorkerDelegationGrantThreads.up(db);

    expect(await threadIdOf('wt-bare')).toBe('slack:C0BU6RSGAGK:1788596827.545309');
  });

  it('leaves a thread id its adapter already addresses untouched', async () => {
    await seedGrant('wt-ok', 'slack:C0BU6RSGAGK', 'slack:C0BU6RSGAGK:1788596060.163699');

    await moduleWorkerDelegationGrantThreads.up(db);
    await moduleWorkerDelegationGrantThreads.up(db);

    expect(await threadIdOf('wt-ok')).toBe('slack:C0BU6RSGAGK:1788596060.163699');
  });

  it('leaves an unbound grant unbound', async () => {
    await seedGrant('wt-unbound', 'slack:C0BU6RSGAGK', '');

    await moduleWorkerDelegationGrantThreads.up(db);

    expect(await threadIdOf('wt-unbound')).toBe('');
  });

  it('leaves a platform address that carries no channel prefix alone', async () => {
    await seedGrant('wt-native', '+15551234567', '1788596827.545309');

    await moduleWorkerDelegationGrantThreads.up(db);

    expect(await threadIdOf('wt-native')).toBe('1788596827.545309');
  });
});
