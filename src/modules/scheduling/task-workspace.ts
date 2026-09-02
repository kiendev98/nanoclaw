/**
 * What identifies a repo-scoped task.
 *
 * A task that names a repository is the pair **(repository, task series)**, and
 * everything else about it is derived. The series id is the load-bearing half.
 *
 * IT MUST NOT BE THE SESSION ID. `findSystemSession` filters `status =
 * 'active'`, so once `shouldCloseTaskSession` closes a spent one-shot,
 * `resolveTaskSession` mints a session with a NEW id on the next run. A branch
 * derived from the session would therefore fork on every fire, leaving each
 * previous run's commits stranded on a branch nothing looks at again — the
 * same divergence `worker-identity.ts` was written to prevent, with a slower
 * fuse. The series id outlives every session it runs in, so one series owns
 * exactly one branch.
 *
 * `taskWorkspace` is a pure function of (repo, series), and
 * `sessions.workspace_path` stores its result so the spawn reads a value rather
 * than re-deriving one.
 */
import { PROJECT_ROOTS } from '../../config.js';
import { createWorktree, resolveRepo, worktreePath } from '../../worktree.js';

/**
 * The branch a repo-scoped task gets.
 *
 * Namespaced under `nanoclaw/` so a human reading `git branch` in their own
 * checkout can tell at a glance which branches an agent made, and suffixed with
 * the series so the branch names the task it belongs to.
 */
export function taskBranch(seriesId: string): string {
  return `nanoclaw/${seriesId}`;
}

/**
 * Where the task for `(repoPath, seriesId)` keeps its worktree.
 *
 * @param repoPath Absolute path of the repository, already resolved against the
 *   operator allowlist by `resolveRepo`. Never a name from chat.
 * @param seriesId The task series that owns the branch.
 */
export function taskWorkspace(repoPath: string, seriesId: string): string {
  return worktreePath(repoPath, taskBranch(seriesId));
}

/**
 * Resolve a repository name and put the series' worktree on disk.
 *
 * Idempotent on the resulting path, so this is both the create path and the
 * repair path. `ncl worktrees prune` removes a clean worktree without touching
 * the row that points at it, and a human can `rm -rf` one just as easily — so
 * every run calls this, and a missing directory is rebuilt rather than
 * discovered by a spawn that chdirs into nothing.
 *
 * @returns The absolute worktree path, or the agent-facing reason there is
 *   none. Never throws: callers answer a blocking tool, and an unhandled throw
 *   there is a request that dies silently.
 */
export function prepareTaskWorkspace(
  repoName: string,
  seriesId: string,
): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const repoPath = resolveRepo(repoName, PROJECT_ROOTS);
    return { ok: true, path: createWorktree(repoPath, taskBranch(seriesId)) };
  } catch (err) {
    return {
      ok: false,
      error: `Cannot prepare a workspace in "${repoName}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
