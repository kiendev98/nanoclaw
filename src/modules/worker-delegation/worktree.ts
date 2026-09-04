/**
 * The isolated working copy a helper stands in.
 *
 * One worktree per helper session, on a branch of its own, so two helpers
 * working the same repository at once cannot share a working copy — git itself
 * refuses a second worktree on one branch, which is what makes A8 structural
 * rather than a convention.
 *
 * Worktrees are created and locked, never deleted here. "Never delete
 * automatically" can be tightened later; the reverse loses work.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { log } from '../../log.js';
import { WORKTREES_DIR } from '../../workspace.js';

export interface WorktreeHandle {
  worktreePath: string;
  branchName: string;
}

/**
 * A failure whose message is safe to show an agent.
 *
 * git reports host paths in its own errors, and E3 forbids showing one, so the
 * detail is logged and never carried in the message.
 */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeError';
  }
}

/**
 * The author every delegated commit carries.
 *
 * Derived from the repository, never from the operator's own git identity: a
 * pushed commit's author is permanent history in a repository nanoclaw does not
 * own. `.invalid` is reserved by RFC 2606, so the address cannot collide with a
 * real contributor's.
 */
function commitIdentity(repoName: string): { name: string; email: string } {
  return { name: `${repoName} worker (nanoclaw)`, email: `worker+${repoName}@nanoclaw.invalid` };
}

/**
 * Every git call the host makes runs synchronously on its single event loop.
 * A checkout on a stalled network mount would otherwise hang the whole host,
 * delivery poll and sweep included, with no bound. Matches the 30s the shared
 * `Cli` seam applies, which this cannot use because it takes no `cwd`.
 */
const GIT_TIMEOUT_MS = 30_000;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
  }).trim();
}

/** `nanoclaw/worker/<session>` — unique per session, so git enforces A8. */
export function workerBranchName(helperSessionId: string): string {
  return `nanoclaw/worker/${helperSessionId}`;
}

export function workerWorktreePath(repoName: string, helperSessionId: string): string {
  return path.join(WORKTREES_DIR, repoName, helperSessionId);
}

/**
 * Create the helper's working copy, or hand back the one it already has.
 *
 * Idempotent on the session id: a respawned helper finds its own worktree
 * rather than a second one.
 */
export function ensureWorktree(repoPath: string, repoName: string, helperSessionId: string): WorktreeHandle {
  const worktreePath = workerWorktreePath(repoName, helperSessionId);
  const branchName = workerBranchName(helperSessionId);
  if (fs.existsSync(path.join(worktreePath, '.git'))) return { worktreePath, branchName };

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  try {
    git(repoPath, ['worktree', 'add', '-b', branchName, worktreePath]);
  } catch (err) {
    // Two delegations for one conversation can reach this line together: both
    // resolve the same session, so both compute the same path and branch, and
    // git refuses the second. The loser wants the winner's worktree, not an
    // error — the caller asked for a working copy, and one now exists.
    if (fs.existsSync(path.join(worktreePath, '.git'))) {
      log.info('Worker worktree already created by a concurrent request', { repoName, helperSessionId });
      return { worktreePath, branchName };
    }
    log.error('Worker worktree creation failed', { repoName, helperSessionId, err });
    throw new WorktreeError(`Could not create a working copy of "${repoName}". The operator has the details.`);
  }

  const identity = commitIdentity(repoName);
  try {
    git(worktreePath, ['config', 'user.name', identity.name]);
    git(worktreePath, ['config', 'user.email', identity.email]);
  } catch (err) {
    // The worker falls back to whatever identity the clone carries, which is
    // usually the operator's own. Worth knowing, not worth refusing the task.
    log.warn('Worker commit identity not set', { repoName, helperSessionId, err });
  }

  try {
    git(repoPath, ['worktree', 'lock', worktreePath]);
  } catch (err) {
    // An unlocked worktree is one `git worktree prune` from deletion.
    // Pruning takes the worker's uncommitted work with it.
    // The operator runs that command in their own clone.
    // Nothing there shows this directory is live.
    log.error('Worker worktree could not be locked — prune in the source clone would discard it', {
      repoName,
      helperSessionId,
      worktreePath,
      err,
    });
  }

  log.info('Worker worktree created', { repoName, helperSessionId, branchName });
  return { worktreePath, branchName };
}
