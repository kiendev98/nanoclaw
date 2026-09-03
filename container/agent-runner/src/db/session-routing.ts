/**
 * Current chat/thread routing for this session — written by the host on every
 * container wake (see src/session-manager.ts `writeSessionRouting`).
 *
 * Read by MCP tools to preserve the current thread when an explicitly named
 * destination resolves to the chat this session is bound to.
 */
import { getAgentMailbox } from '../mailbox/index.js';

export interface SessionRouting {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

export function getSessionRouting(): SessionRouting {
  const routing = getAgentMailbox().operations.getSessionRouting();
  return {
    channel_type: routing.channelType,
    platform_id: routing.platformId,
    thread_id: routing.threadId,
  };
}

const TASK_THREAD_PREFIX = 'system:tasks:';

/**
 * The task series this session is a run of, or null for a chat session.
 *
 * PREFERS `NANOCLAW_TASK_SERIES_ID`, which the host sets once per spawn, over
 * parsing `routing.thread_id`. The two facts used to share that one field and
 * they have different lifetimes: task identity is fixed for the life of a
 * spawn, while the outbound route is MUTABLE — the host rewrites it the moment
 * this session binds the thread it opened, so replies land in that thread
 * rather than at top level.
 *
 * Reading identity off the mutable field meant a task session stopped
 * recognising itself the instant it opened a thread: this function returned
 * null, and the PreCompact hook — which runs mid-session — swapped the task
 * delivery contract for the chat one, telling the agent to wrap its answers in
 * <message> blocks during a task run.
 *
 * An ABSENT variable means an older host that never set it, and only then is
 * the legacy parse consulted. Present-and-empty is a current host stating
 * "this is not a task session".
 */
export function getTaskSeriesId(): string | null {
  const fromEnv = process.env.NANOCLAW_TASK_SERIES_ID;
  if (fromEnv !== undefined) return fromEnv || null;

  const threadId = getSessionRouting().thread_id;
  return threadId?.startsWith(TASK_THREAD_PREFIX) ? threadId.slice(TASK_THREAD_PREFIX.length) : null;
}
