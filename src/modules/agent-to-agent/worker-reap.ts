/**
 * Retire repo-scoped workers whose conversation is finished.
 *
 * A worker is created per (repository, thread). Ninety-three repositories over a
 * few weeks of conversations is ninety-three agent groups, ninety-three group
 * folders and ninety-three worktrees, none of which anything will ever address
 * again. Nothing else in the host removes them, because nothing else knows they
 * were temporary — `origin_session_id` is the column that knows.
 *
 * This runs as a sweep singleton, a central-DB scan once per tick, beside the
 * approvals scan. It is not a new timer: the host already has exactly one, and a
 * second one is a second thing to start, stop and reason about at shutdown.
 *
 * ## The safety rule
 *
 * `removeWorktree` had no caller before this, on purpose. Deleting a directory
 * that holds an agent's uncommitted work is unrecoverable, so this module never
 * deletes one it cannot PROVE is empty of work — see `inspectWorktree`, whose
 * every failure path answers "not clean". A retained worktree costs a few
 * megabytes and a log line; a deleted one costs a day of someone's work.
 *
 * When the worktree is retained, the group registration is still reaped. The
 * conversation that owned the worker is over, so the worker is unreachable
 * either way, and leaving the row behind would defeat the whole point. What
 * must NOT be lost is the PATH, so it is logged and posted into the originating
 * thread — a directory nobody can name is as good as deleted.
 *
 * Neither `git worktree remove --force` nor `rm -rf` appears here or in
 * `worktree.ts`. Both turn "I could not prove this is safe" into "I destroyed
 * it anyway", which is the failure this module exists to avoid.
 */
import { deleteAgentGroupCascade, getWorkerAgentGroups } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import { isContainerRunning } from '../../container-runner.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { AgentGroup, Session } from '../../types.js';
import { inspectWorktree, removeWorktree, worktreeRepoName } from '../../worktree.js';
import { getDestinationReferencers } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

/**
 * How long a conversation must be silent before its workers are considered
 * finished with.
 *
 * A day, because a thread is a unit of someone's working day, and because
 * getting this wrong in the early direction is nearly free: the branch is named
 * after the ORIGIN SESSION, and `git worktree remove` leaves branches alone, so
 * the next `create_agent({ repo })` in that same thread checks the same branch
 * back out into the same worktree with the same commits. Reaping too early
 * costs one `git worktree add`.
 */
export const WORKER_IDLE_MS = 24 * 60 * 60 * 1000;

/** The state a reap decision is made from. `origin: null` means the row is gone. */
export interface WorkerReapInput {
  now: number;
  origin: { status: Session['status']; lastActiveMs: number } | null;
  /** Any container of the worker's own sessions is alive. */
  workerBusy: boolean;
  /** Newest `last_active` across the worker's own sessions, 0 when it has none. */
  workerLastActiveMs: number;
}

export type WorkerReapDecision = { reap: false; reason: string } | { reap: true; reason: string };

/**
 * Should this worker be retired? Pure, so every branch is testable without a
 * database, a container or a git repository.
 *
 * The two "is the worker itself finished" rules come FIRST and apply even when
 * the originating session is already gone. A closed thread is not a licence to
 * interrupt a worker mid-turn — the human closed a conversation, not a build.
 */
export function decideWorkerReap(input: WorkerReapInput): WorkerReapDecision {
  if (input.workerBusy) return { reap: false, reason: 'the worker is mid-turn' };
  if (input.now - input.workerLastActiveMs < WORKER_IDLE_MS) {
    return { reap: false, reason: 'the worker was active recently' };
  }
  if (!input.origin) return { reap: true, reason: 'the originating session no longer exists' };
  if (input.origin.status === 'closed') return { reap: true, reason: 'the originating session is closed' };
  if (input.now - input.origin.lastActiveMs >= WORKER_IDLE_MS) {
    return { reap: true, reason: 'the originating conversation has been silent for a day' };
  }
  return { reap: false, reason: 'the originating conversation is still live' };
}

/** `last_active` as epoch ms, falling back to creation — never to "now". */
function activityMs(session: Session): number {
  const parsed = Date.parse(session.last_active ?? session.created_at);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * One sweep pass. Never throws: a reap failure must not take down the tick that
 * also re-heals egress and finalizes approvals.
 *
 * @returns How many workers were retired, for the log line and for tests.
 */
export async function reapFinishedWorkers(): Promise<number> {
  const workers = await getWorkerAgentGroups();
  if (workers.length === 0) return 0;

  let reaped = 0;
  for (const worker of workers) {
    try {
      if (await reapWorker(worker)) reaped += 1;
    } catch (err) {
      log.error('Worker reap failed — leaving the worker in place', { worker: worker.id, err });
    }
  }
  return reaped;
}

async function reapWorker(worker: AgentGroup): Promise<boolean> {
  const ownSessions = await getSessionsByAgentGroup(worker.id);
  const origin = worker.origin_session_id ? await getSession(worker.origin_session_id) : undefined;

  const decision = decideWorkerReap({
    now: Date.now(),
    origin: origin ? { status: origin.status, lastActiveMs: activityMs(origin) } : null,
    workerBusy: ownSessions.some((s) => isContainerRunning(s.id)),
    workerLastActiveMs: ownSessions.reduce((newest, s) => Math.max(newest, activityMs(s)), 0),
  });
  if (!decision.reap) return false;

  const retained = worker.workspace_path ? releaseWorktree(worker.workspace_path) : null;

  // Read the referencers BEFORE the cascade: their rows are what identifies
  // them, and the cascade deletes those rows.
  const referencers = await getDestinationReferencers(worker.id);
  await deleteAgentGroupCascade(worker.id);
  await reprojectDestinations(referencers);

  log.info('Retired a finished repo worker', {
    worker: worker.id,
    name: worker.name,
    origin: worker.origin_session_id,
    reason: decision.reason,
    retainedWorktree: retained?.path,
    retainedReason: retained?.reason,
  });

  if (retained && origin) await announceRetainedWorktree(worker, origin, retained);
  return true;
}

/**
 * Delete the worktree if — and only if — deleting it destroys nothing.
 *
 * @returns `null` when the directory is gone, or the path and the reason it was
 *   kept. A `removeWorktree` that silently declined (it logs and swallows, so
 *   that a locked or busy worktree cannot break a sweep) is reported as kept:
 *   the caller must announce a directory that is still there.
 */
function releaseWorktree(worktree: string): { path: string; reason: string } | null {
  const state = inspectWorktree(worktree);
  if (!state.clean) return { path: worktree, reason: state.reason };

  removeWorktree(worktree);
  const stillThere = inspectWorktree(worktree);
  // `inspectWorktree` reports an absent path as clean with that exact reason,
  // which is the one case that means "gone".
  if (stillThere.reason === 'the worktree is already gone') return null;
  return { path: worktree, reason: 'git declined to remove it' };
}

/** Refresh the destination projection of every agent that could still address the worker. */
async function reprojectDestinations(referencers: readonly string[]): Promise<void> {
  for (const agentGroupId of referencers) {
    for (const session of await getSessionsByAgentGroup(agentGroupId)) {
      if (session.status !== 'active') continue;
      try {
        await writeDestinations(agentGroupId, session.id);
      } catch (err) {
        // The next container wake re-projects anyway; a stale name resolves to
        // "unknown destination", which is noisy but not harmful.
        log.warn('Could not re-project destinations after a worker reap', { agentGroupId, session: session.id, err });
      }
    }
  }
}

/**
 * Tell the originating thread where the retained worktree is.
 *
 * A directory nobody can name is as good as deleted, and the human who owns the
 * work is the one reading this thread. Best-effort: the group is already gone by
 * the time this runs, so a failure here loses the message, not the files, and
 * the same path is in the log.
 */
async function announceRetainedWorktree(
  worker: AgentGroup,
  origin: Session,
  retained: { path: string; reason: string },
): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter || !origin.messaging_group_id) return;
  const mg = await getMessagingGroup(origin.messaging_group_id);
  if (!mg || mg.detached_at) return;

  const text =
    `Retired the \`${worktreeRepoName(retained.path)}\` worker *${worker.name}* for this thread.\n` +
    `Its worktree has ${retained.reason}, so I did not delete it:\n\`${retained.path}\`\n` +
    'Commit or discard it there, then remove it with `git worktree remove`.';
  try {
    await adapter.deliver(
      mg.channel_type,
      mg.platform_id,
      origin.thread_id,
      'chat',
      JSON.stringify({ text }),
      undefined,
      mg.instance,
    );
  } catch (err) {
    log.warn('Could not announce a retained worktree — the path is in the log above', {
      worker: worker.id,
      path: retained.path,
      err,
    });
  }
}
