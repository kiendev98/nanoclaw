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

import { log } from '../../../log.js';
import { WORKTREES_DIR } from '../../../workspace.js';

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

interface DeclaredSubmodule {
  name: string;
  path: string;
}

/**
 * Fill the worker's submodules from the source clone, without the network.
 *
 * `git worktree add` writes each gitlink and leaves the directory empty. Git's
 * own documentation calls submodule support in worktrees incomplete. A worker
 * handed an empty submodule does not stop. It reads the operator's own checkout
 * instead, outside its branch, where nothing captures what it changes.
 *
 * `git submodule update --init` is the usual answer, and it clones from the
 * remote every time. One measured submodule cost 47MB and a network round trip
 * per worker, against the 30 second cap this module puts on a host thread.
 * The source clone already holds those objects under its shared git directory.
 * A worktree of that store costs 8KB and reaches no network at all.
 */
function ensureSubmodules(repoPath: string, worktreePath: string, repoName: string, helperSessionId: string): void {
  for (const submodule of declaredSubmodules(worktreePath)) {
    const target = path.join(worktreePath, submodule.path);
    if (fs.existsSync(path.join(target, '.git'))) continue;

    try {
      placeSubmodule(repoPath, worktreePath, submodule, target);
    } catch (err) {
      log.error('Worker submodule could not be checked out', {
        repoName,
        helperSessionId,
        submodule: submodule.path,
        err,
      });
      throw new WorktreeError(
        `Could not check out the "${submodule.path}" submodule of "${repoName}". The operator has the details.`,
      );
    }
  }
}

/**
 * What the checked-out tree declares, or nothing when it declares no submodule.
 *
 * The name and the path are both read, because git stores a submodule under its
 * name and checks it out at its path. The two are equal by default and diverge
 * when a submodule moves.
 */
function declaredSubmodules(worktreePath: string): DeclaredSubmodule[] {
  if (!fs.existsSync(path.join(worktreePath, '.gitmodules'))) return [];

  const config = git(worktreePath, ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']);
  return config
    .split('\n')
    .map((line) => {
      const separator = line.indexOf(' ');
      if (separator < 0) return undefined;
      const name = line.slice(0, separator).slice('submodule.'.length, -'.path'.length);
      const declaredPath = line.slice(separator + 1).trim();
      return name && declaredPath ? { name, path: declaredPath } : undefined;
    })
    .filter((entry): entry is DeclaredSubmodule => entry !== undefined);
}

/**
 * One submodule, from the source clone when it can supply it.
 *
 * The clone is the fallback rather than the route. It runs when the source
 * clone never initialized this submodule, and when its store lacks the commit
 * the superproject points at. Both cases need the remote, and nothing local
 * can answer them.
 */
function placeSubmodule(repoPath: string, worktreePath: string, submodule: DeclaredSubmodule, target: string): void {
  if (placeFromSourceClone(repoPath, worktreePath, submodule, target)) return;
  git(worktreePath, ['submodule', 'update', '--init', '--', submodule.path]);
}

/** True when the submodule now stands in the worktree, taken from local objects. */
function placeFromSourceClone(
  repoPath: string,
  worktreePath: string,
  submodule: DeclaredSubmodule,
  target: string,
): boolean {
  const moduleDir = path.join(commonGitDir(repoPath), 'modules', submodule.name);
  if (!fs.existsSync(moduleDir)) return false;

  try {
    const commit = git(worktreePath, ['rev-parse', `HEAD:${submodule.path}`]);
    git(moduleDir, ['worktree', 'add', '--detach', target, commit]);
  } catch (err) {
    log.info('Worker submodule not available locally, falling back to a clone', {
      submodule: submodule.path,
      err,
    });
    return false;
  }

  try {
    git(moduleDir, ['worktree', 'lock', target]);
  } catch (err) {
    // A prune inside the submodule discards this directory and the worker's
    // uncommitted work in it.
    // The superproject worktree carries the same risk for the same reason.
    log.error('Worker submodule worktree could not be locked', { submodule: submodule.path, target, err });
  }

  return true;
}

/** The git directory worktrees share, which is where an initialized submodule lives. */
function commonGitDir(repoPath: string): string {
  return path.resolve(repoPath, git(repoPath, ['rev-parse', '--git-common-dir']));
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
  if (fs.existsSync(path.join(worktreePath, '.git'))) {
    // A delegation that failed the submodule step leaves a worktree behind, so
    // the retry finds it here. Repair it rather than hand back the hollow tree.
    ensureSubmodules(repoPath, worktreePath, repoName, helperSessionId);
    return { worktreePath, branchName };
  }

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
      ensureSubmodules(repoPath, worktreePath, repoName, helperSessionId);
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

  // Last, after the lock. A submodule failure then leaves a worktree the retry
  // can repair, rather than one no prune protects.
  ensureSubmodules(repoPath, worktreePath, repoName, helperSessionId);

  log.info('Worker worktree created', { repoName, helperSessionId, branchName });
  return { worktreePath, branchName };
}
