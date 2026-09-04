/** `worker_channel_grants` — one lent conversation, bound to one thread. */
import { getDb } from '../../../db/connection.js';
import type { WorkerChannelGrant } from '../types.js';

export async function createGrant(grant: WorkerChannelGrant): Promise<void> {
  await getDb().run(
    `INSERT INTO worker_channel_grants (
        task_id, helper_agent_group_id, helper_session_id, messaging_group_id, channel_type,
        platform_id, root_message_id, thread_id, local_destination_name, granted_by_session_id,
        granted_at, released_at
      ) VALUES (
        @task_id, @helper_agent_group_id, @helper_session_id, @messaging_group_id, @channel_type,
        @platform_id, @root_message_id, @thread_id, @local_destination_name, @granted_by_session_id,
        @granted_at, @released_at
      )`,
    { ...grant },
  );
}

/**
 * Bind a grant to the thread its root post started.
 *
 * The platform names the thread, and it only does so once the root message is
 * delivered — so the grant is written unbound and stamped here.
 */
export async function bindGrantThread(
  rootMessageId: string,
  threadId: string,
): Promise<WorkerChannelGrant | undefined> {
  const result = await getDb().run(
    "UPDATE worker_channel_grants SET thread_id = ? WHERE root_message_id = ? AND thread_id = ''",
    threadId,
    rootMessageId,
  );
  if (result.changes === 0) return undefined;
  return getDb().get<WorkerChannelGrant>(
    'SELECT * FROM worker_channel_grants WHERE root_message_id = ?',
    rootMessageId,
  );
}

/** The live grant for a helper session, if it holds one. */
export async function findLiveGrantForSession(helperSessionId: string): Promise<WorkerChannelGrant | undefined> {
  return getDb().get<WorkerChannelGrant>(
    'SELECT * FROM worker_channel_grants WHERE helper_session_id = ? AND released_at IS NULL LIMIT 1',
    helperSessionId,
  );
}

export async function findLiveGrantForTask(taskId: string): Promise<WorkerChannelGrant | undefined> {
  return getDb().get<WorkerChannelGrant>(
    'SELECT * FROM worker_channel_grants WHERE task_id = ? AND released_at IS NULL',
    taskId,
  );
}

/**
 * The helper that owns a thread, if any.
 *
 * The router asks this of every inbound message on a threaded channel, so it is
 * indexed on exactly this shape.
 */
export async function findLiveGrantForThread(
  messagingGroupId: string,
  threadId: string,
): Promise<WorkerChannelGrant | undefined> {
  return getDb().get<WorkerChannelGrant>(
    'SELECT * FROM worker_channel_grants WHERE messaging_group_id = ? AND thread_id = ? AND released_at IS NULL',
    messagingGroupId,
    threadId,
  );
}

/** Ends with the task, so nothing is left for an operator to remove (D9). */
export async function releaseGrant(taskId: string, releasedAt: string): Promise<WorkerChannelGrant | undefined> {
  const grant = await findLiveGrantForTask(taskId);
  if (!grant) return undefined;
  await getDb().run(
    'UPDATE worker_channel_grants SET released_at = ? WHERE task_id = ? AND released_at IS NULL',
    releasedAt,
    taskId,
  );
  return grant;
}
