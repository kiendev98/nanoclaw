/**
 * What identifies a repo-scoped worker.
 *
 * A worker is not "an agent someone asked for". It is the pair
 * **(repository, originating thread)**, and everything else about it is
 * derived. That is the whole answer to the trap this module exists to close:
 * a second `create_agent({ repo })` in the same thread used to mint a second
 * agent on a second branch, which could not see the first one's work and
 * silently produced two divergent answers to one conversation.
 *
 * So the branch is derived from the ORIGIN SESSION rather than from the
 * agent's own folder. The branch was the last piece that made two workers for
 * the same (repo, thread) representable: derive it from the folder and the
 * second worker gets `nanoclaw/scout-2` beside `nanoclaw/scout`, two real
 * branches with two real worktrees. Derived from the origin session there is
 * exactly one branch per (repo, thread), and `createWorktree` — which is
 * already idempotent on its path — adopts it rather than duplicating it.
 *
 * `workerWorkspace` is therefore a pure function of (repo, origin session), and
 * `agent_groups.workspace_path` stores its result. That is why
 * `findWorkerForOrigin(originSessionId, workspacePath)` is a lookup by the
 * (repo, thread) key and not by two loosely-related filters.
 */
import { worktreePath } from '../../worktree.js';

/**
 * The branch a repo-scoped worker gets.
 *
 * Namespaced under `nanoclaw/` so a human reading `git branch` in their own
 * checkout can tell at a glance which branches an agent made, and suffixed with
 * the originating session so the branch names the conversation it belongs to.
 */
export function workerBranch(originSessionId: string): string {
  return `nanoclaw/${originSessionId}`;
}

/**
 * Where the worker for `(repoPath, originSessionId)` keeps its worktree.
 *
 * @param repoPath Absolute path of the repository, already resolved against the
 *   operator allowlist by `resolveRepo`. Never a name from chat.
 * @param originSessionId The session that asked for the worker.
 */
export function workerWorkspace(repoPath: string, originSessionId: string): string {
  return worktreePath(repoPath, workerBranch(originSessionId));
}
