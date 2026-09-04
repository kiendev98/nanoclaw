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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
    log.error('Worker worktree creation failed', { repoName, helperSessionId, err });
    throw new WorktreeError(`Could not create a working copy of "${repoName}". The operator has the details.`);
  }

  const identity = commitIdentity(repoName);
  try {
    git(worktreePath, ['config', 'user.name', identity.name]);
    git(worktreePath, ['config', 'user.email', identity.email]);
    // Locked so `git worktree prune` in the operator's own clone cannot
    // discard a helper's uncommitted work.
    git(repoPath, ['worktree', 'lock', worktreePath]);
  } catch (err) {
    log.warn('Worker worktree post-setup failed', { repoName, helperSessionId, err });
  }

  log.info('Worker worktree created', { repoName, helperSessionId, branchName });
  return { worktreePath, branchName };
}
