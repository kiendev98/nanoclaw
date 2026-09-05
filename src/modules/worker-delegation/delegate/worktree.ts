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

/**
 * One budget for every submodule of one worktree, network fallbacks included.
 *
 * Each fallback clone reaches the remote on the same host thread. A per-call
 * timeout bounds one clone and not the pass, so a repository with several
 * uninitialized submodules could hold the host for a multiple of it.
 */
const SUBMODULE_BUDGET_MS = 60_000;

/**
 * The least a clone can be given and still mean anything.
 *
 * One budget covers every submodule of a pass, so a slow first clone can leave
 * the next one a few milliseconds. Running git with that is a hard failure
 * dressed as a timeout: the submodule was resolvable and was only starved.
 * Below this, the pass reports the budget spent, which warns and continues.
 */
const MIN_SUBMODULE_CLONE_MS = 5_000;

function git(cwd: string, args: string[], timeoutMs: number = GIT_TIMEOUT_MS): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  }).trim();
}

/**
 * Run git where a non-zero exit is an answer rather than a fault.
 *
 * `git config --get-regexp` exits 1 when nothing matches, and `rev-parse` exits
 * 128 for a path that is not a gitlink. Both are states this module reads.
 */
function gitOrNull(cwd: string, args: string[]): string | null {
  /* eslint-disable no-catch-all/no-catch-all -- the exit status is the result */
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
  /* eslint-enable no-catch-all/no-catch-all */
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
  const declared = declaredSubmodules(worktreePath);
  if (declared.length === 0) return;

  // One `rev-parse` for the pass. The value is a property of the source clone
  // and cannot change inside the loop, so asking per submodule spends a
  // subprocess per iteration for an answer already held.
  const modulesRoot = sourceModulesRoot(repoPath, repoName, helperSessionId);
  const deadline = Date.now() + SUBMODULE_BUDGET_MS;
  const prunable: string[] = [];

  for (const submodule of declared) {
    const target = path.join(worktreePath, submodule.path);
    // One outcome is not the repository's shape and does not heal: a worktree
    // that took neither the lock nor the withdrawal. Reading the directory back
    // is what makes a retry find that residual, because it carries a `.git` and
    // a check on that alone skips it forever.
    const standing = submoduleStanding(modulesRoot, submodule, target);
    if (standing === 'sound') continue;
    if (standing === 'prunable') {
      log.error('Worker submodule holds an unlocked worktree', {
        repoName,
        helperSessionId,
        submodule: submodule.path,
      });
      prunable.push(submodule.path);
      continue;
    }

    try {
      const unresolvable = placeSubmodule(worktreePath, modulesRoot, submodule, target, deadline);
      if (!unresolvable) continue;
      if (submoduleStanding(modulesRoot, submodule, target) === 'prunable') {
        log.error('Worker submodule holds an unlocked worktree', {
          repoName,
          helperSessionId,
          submodule: submodule.path,
          reason: unresolvable,
        });
        prunable.push(submodule.path);
        continue;
      }
      // A declaration this checkout cannot satisfy is the repository's shape,
      // not a fault of the delegation. Refusing the task would strand every
      // worker on a repository carrying one stale stanza. The path is usually
      // left empty, and the reason says when it is not.
      log.warn('Worker submodule not placed', {
        repoName,
        helperSessionId,
        submodule: submodule.path,
        reason: unresolvable,
      });
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

  // Refusing inside the loop would fail the whole pass for one broken
  // submodule, and every sound one after it would never be placed. Collecting
  // keeps each submodule's fault to itself and still puts a person in the loop
  // before a worker writes into a directory one prune from deletion.
  if (prunable.length > 0) {
    throw new WorktreeError(
      `The ${prunable.map((entry) => `"${entry}"`).join(', ')} submodule of "${repoName}" holds a worktree that is neither locked nor withdrawn. The operator has the details.`,
    );
  }
}

/**
 * How a submodule directory stands before this pass touches it.
 *
 * `sound` is the skip: either the directory is a checkout no prune can reach,
 * or it is a worktree the source store holds locked. `prunable` is the residual
 * a failed lock and a failed withdrawal leave behind — it carries a `.git`, so
 * a check on that alone reads it as placed and never looks again.
 */
function submoduleStanding(
  modulesRoot: string | null,
  submodule: DeclaredSubmodule,
  target: string,
): 'absent' | 'sound' | 'prunable' {
  if (!fs.existsSync(path.join(target, '.git'))) return 'absent';
  if (modulesRoot === null) return 'sound';

  const moduleDir = path.join(modulesRoot, submodule.name);
  if (!fs.existsSync(moduleDir)) return 'sound';
  return isPrunableWorktree(moduleDir, target) ? 'prunable' : 'sound';
}

/**
 * Does the store list this path as a worktree it does not hold locked?
 *
 * `worktree list --porcelain` prints one block per worktree, a `worktree <path>`
 * line first and a bare `locked` line when the lock took. A cloned submodule is
 * an ordinary directory and appears in no block, so absence reads as sound.
 */
function isPrunableWorktree(moduleDir: string, target: string): boolean {
  const listed = gitOrNull(moduleDir, ['worktree', 'list', '--porcelain']);
  if (listed === null) return false;

  const wanted = realPath(target);
  for (const block of listed.split('\n\n')) {
    const lines = block.split('\n');
    const head = lines.find((line) => line.startsWith('worktree '));
    if (head === undefined || realPath(head.slice('worktree '.length)) !== wanted) continue;
    return !lines.some((line) => line === 'locked' || line.startsWith('locked '));
  }
  return false;
}

/** git prints the resolved path, and the caller builds an unresolved one. */
function realPath(target: string): string {
  /* eslint-disable no-catch-all/no-catch-all -- an unresolvable path is the result */
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
  /* eslint-enable no-catch-all/no-catch-all */
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

  // `--get-regexp` exits 1 when nothing matches, which a `.gitmodules` holding
  // only comments or a stanza without a path does. That is no submodules.
  const config = gitOrNull(worktreePath, [
    'config',
    '--file',
    '.gitmodules',
    '--get-regexp',
    '^submodule\\..*\\.path$',
  ]);
  if (config === null) return [];

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
function placeSubmodule(
  worktreePath: string,
  modulesRoot: string | null,
  submodule: DeclaredSubmodule,
  target: string,
  deadline: number,
): string | null {
  // A stanza whose path is no longer a gitlink outlives the submodule it
  // named. Neither route can satisfy it, and both fail on the retry too.
  const commit = gitOrNull(worktreePath, ['rev-parse', `HEAD:${submodule.path}`]);
  if (!commit) return 'the declared path is not a gitlink in HEAD';

  // Both routes refuse a directory that already holds files, so an interrupted
  // attempt would otherwise fail here forever.
  if (holdsFiles(target)) return 'the path already holds files from an earlier attempt';

  const placement = placeFromSourceClone(modulesRoot, submodule, target, commit);
  if (placement === 'placed') return null;
  // The caller reads the directory back rather than trusting this word for it,
  // so the same answer reaches a retry that never runs this function again.
  if (placement === 'unlocked') return 'the submodule worktree could not be locked, and could not be withdrawn';

  const remaining = deadline - Date.now();
  if (remaining < MIN_SUBMODULE_CLONE_MS) return 'the submodule budget was spent before this clone';

  git(worktreePath, ['submodule', 'update', '--init', '--', submodule.path], remaining);
  return null;
}

/** True when a path exists and is a directory holding at least one entry. */
function holdsFiles(target: string): boolean {
  return fs.existsSync(target) && fs.statSync(target).isDirectory() && fs.readdirSync(target).length > 0;
}

/**
 * What the local route did with one submodule.
 *
 * `unavailable` is the caller's cue to reach the remote. `unlocked` is not: the
 * worktree was added, could not be locked, and could not be withdrawn either,
 * so the path now holds a directory no route may overwrite.
 */
type SourcePlacement = 'placed' | 'unavailable' | 'unlocked';

/** The submodule taken from local objects, or why the caller must clone instead. */
function placeFromSourceClone(
  modulesRoot: string | null,
  submodule: DeclaredSubmodule,
  target: string,
  commit: string,
): SourcePlacement {
  if (modulesRoot === null) return 'unavailable';
  const moduleDir = path.join(modulesRoot, submodule.name);
  if (!fs.existsSync(moduleDir)) return 'unavailable';

  try {
    git(moduleDir, ['worktree', 'add', '--detach', target, commit]);
  } catch (err) {
    // The store exists but lacks this commit, so only the remote has it.
    log.info('Worker submodule not available locally, falling back to a clone', {
      submodule: submodule.path,
      err,
    });
    return 'unavailable';
  }

  try {
    git(moduleDir, ['worktree', 'lock', target]);
    return 'placed';
  } catch (err) {
    // An unlocked worktree is one prune away from losing the worker's work.
    // Reporting it as placed hides that for the life of the worker, so
    // withdraw it while it is still empty and let the clone route answer.
    // A cloned submodule is an ordinary directory that no prune can reach.
    log.error('Worker submodule worktree could not be locked — withdrawing it', {
      submodule: submodule.path,
      target,
      err,
    });
  }

  return withdrawWorktree(moduleDir, target) ? 'unavailable' : 'unlocked';
}

/** True when a worktree this pass just added is gone again, so another route may run. */
function withdrawWorktree(moduleDir: string, target: string): boolean {
  if (gitOrNull(moduleDir, ['worktree', 'remove', '--force', target]) !== null) return true;
  log.error('Worker submodule worktree could not be withdrawn after a failed lock', { moduleDir, target });
  return false;
}

/**
 * Where the source clone keeps its initialized submodules, or null when git
 * cannot say — in which case only the clone route is left.
 */
function sourceModulesRoot(repoPath: string, repoName: string, helperSessionId: string): string | null {
  const commonDir = gitOrNull(repoPath, ['rev-parse', '--git-common-dir']);
  if (commonDir === null) {
    // Every submodule of this pass now takes the network route, and the local
    // route is skipped before the line that reports a fallback. Without this
    // the pass reaches the remote for every submodule and logs no reason.
    log.warn('Worker submodule store could not be located — every submodule will clone', {
      repoName,
      helperSessionId,
    });
    return null;
  }
  return path.join(path.resolve(repoPath, commonDir), 'modules');
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
