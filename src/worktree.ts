/**
 * Repository resolution and git worktree management for repo-scoped agents.
 *
 * An agent loads a repository's `CLAUDE.md`, `.claude/skills/` and
 * `.claude/settings.json` because of ONE thing: its process working directory.
 * Claude Code walks UP from cwd to collect them, and that walk does not stop at
 * a git repository root. So putting an agent "in a repo" means giving it a cwd
 * inside that repo, and nothing else.
 *
 * That makes cwd a security boundary rather than a convenience. A chat message
 * can ask for a repo by name, so the name must never be able to name a path:
 * `resolveRepo` accepts a relative name and resolves it under an operator
 * allowlist (`NANOCLAW_PROJECT_ROOTS`), which is EMPTY by default. With no
 * allowlist there is no repo resolution at all.
 *
 * WHY THE WORKTREE LIVES OUTSIDE THE REPOSITORY: the same upward walk that
 * loads a worktree's own `CLAUDE.md` keeps climbing. A worktree placed inside
 * its target checkout (`<repo>/.worktrees/x`) therefore loads the OUTER
 * checkout's `CLAUDE.md` on top of its own — the exact leak commit 5a592b62
 * fixed for group folders, 11,618 tokens of maintainer guidance meant for a
 * human. So worktrees go under `WORKTREES_DIR`, which is a sibling of nothing.
 *
 * NOTHING HERE RUNS ON A TIMER. A worktree is created by a chat request and
 * removed only by `ncl worktrees prune`, which a human types. There is no
 * sweep, no singleton and no reaper — an earlier one was deleted on purpose
 * (282b8f6d), because a background job that deletes a directory is a background
 * job that can delete a day of work. `inspectWorktree` is the proof that a
 * removal destroys nothing, and `removeWorktree` is never forced.
 *
 * Every git call passes an argv array. A repo or branch name reaches this
 * module from a chat message, and a shell string would make that name
 * executable.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from './log.js';

const HOME_DIR = process.env.HOME || os.homedir();

/**
 * Where worktrees are created. Deliberately under `~/.config/nanoclaw` rather
 * than inside any repository — see the module comment on the upward walk.
 */
export const WORKTREES_DIR = path.join(HOME_DIR, '.config', 'nanoclaw', 'worktrees');

/**
 * Parse `NANOCLAW_PROJECT_ROOTS` into absolute directories.
 *
 * Separated by the platform's path delimiter (`:` on POSIX, `;` on Windows),
 * the same convention `PATH` uses, so an operator writing a list of
 * directories does not have to learn a NanoClaw-specific separator.
 *
 * An empty or whitespace-only value yields an empty list, and an empty list
 * means the feature is off. That default is load-bearing: with no roots
 * configured, no chat message can point an agent's cwd anywhere.
 */
export function parseProjectRoots(value: string): string[] {
  return value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry));
}

/** Why a candidate under one allowlisted root was refused. */
type Rejection = { reason: string } | null;

/**
 * Resolve a repository NAME to an absolute path inside the allowlist.
 *
 * The name is a relative path with no traversal: `saber`, or `wego/saber` for a
 * nested layout. Everything else is refused, and refused loudly — a silent
 * fallback to the group folder would put the agent in the wrong repository
 * while looking like it worked.
 *
 * Symlinks are resolved BEFORE the containment check. A prefix test against an
 * unresolved path reads a symlink inside an allowlisted root as inside it,
 * while the process that later chdirs there lands outside — so containment is
 * judged on the real path or not at all.
 *
 * @param name Relative repository name, as a chat message supplied it.
 * @param roots Allowlisted directories (`PROJECT_ROOTS`).
 * @returns The canonical absolute path of the repository.
 * @throws When the allowlist is empty, the name is not a plain relative name,
 *   or no allowlisted root holds a git repository by that name.
 */
export function resolveRepo(name: string, roots: readonly string[]): string {
  const requested = name.trim();
  if (!requested) throw new Error('repo name is required');

  if (roots.length === 0) {
    throw new Error(
      `Cannot resolve repo "${requested}": no project roots are configured. ` +
        'Set NANOCLAW_PROJECT_ROOTS to a list of directories that may contain repositories.',
    );
  }

  if (path.isAbsolute(requested) || requested.startsWith('~')) {
    throw new Error(
      `Cannot resolve repo "${requested}": a repo is named relative to a project root, never by absolute path. ` +
        `Allowed roots: ${roots.join(', ')}`,
    );
  }

  const segments = requested.split(/[/\\]/);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(
      `Cannot resolve repo "${requested}": the name may not contain '.', '..' or empty path segments. ` +
        `Allowed roots: ${roots.join(', ')}`,
    );
  }

  // Keep the most specific refusal so the error names the real problem rather
  // than "not found", which is what a bare loop would report for a repo that
  // exists but is a symlink out of the allowlist.
  let rejection: Rejection = null;

  for (const root of roots) {
    const outcome = resolveUnderRoot(requested, root);
    if (outcome.path) return outcome.path;
    if (outcome.rejection && !rejection) rejection = outcome.rejection;
  }

  if (rejection) {
    throw new Error(`Cannot resolve repo "${requested}": ${rejection.reason}. Allowed roots: ${roots.join(', ')}`);
  }
  throw new Error(
    `Cannot resolve repo "${requested}": no git repository by that name under any allowed root. ` +
      `Allowed roots: ${roots.join(', ')}`,
  );
}

function resolveUnderRoot(requested: string, root: string): { path?: string; rejection: Rejection } {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    // A configured root that does not exist is an operator error, not a
    // request error — it must not decide this request's message.
    return { rejection: null };
  }

  let real: string;
  try {
    real = fs.realpathSync(path.resolve(realRoot, requested));
  } catch {
    return { rejection: null }; // absent here; another root may hold it
  }

  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    return { rejection: { reason: `it resolves to ${real}, which is outside the allowed roots` } };
  }
  if (!fs.statSync(real).isDirectory()) {
    return { rejection: { reason: `${real} is not a directory` } };
  }
  if (!isGitRepositoryRoot(real)) {
    return { rejection: { reason: `${real} is not a git repository` } };
  }
  return { path: real, rejection: null };
}

/**
 * A repository ROOT, not merely a path inside one.
 *
 * `.git` is a directory in a normal checkout and a file in a worktree, so
 * existence covers both. Testing for the entry rather than shelling to
 * `git rev-parse` is deliberate: it also rejects a SUBDIRECTORY of a
 * repository, which `rev-parse` would happily accept and which would make
 * `<root>/repo/some/sub/dir` a resolvable "repo".
 */
function isGitRepositoryRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/**
 * One path segment safe to put in a directory name.
 *
 * Branch names carry `/` and repo names arrive from chat, so this is what keeps
 * `worktreePath` from being a second traversal surface. Everything outside
 * `[A-Za-z0-9._-]` becomes `-`, runs collapse, and leading dots are stripped so
 * no input can produce `.` or `..`.
 */
export function sanitizeSegment(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '');
}

/**
 * Where the worktree for `(repo, branch)` goes.
 *
 * OUTSIDE the repository, always. See the module comment: a worktree nested in
 * its own checkout inherits the outer checkout's `CLAUDE.md` through the same
 * upward walk that gives it its own.
 *
 * @throws When repo or branch sanitize to nothing (a name of pure punctuation).
 */
export function worktreePath(repo: string, branch: string): string {
  const repoSegment = sanitizeSegment(path.basename(repo));
  const branchSegment = sanitizeSegment(branch);
  if (!repoSegment || !branchSegment) {
    throw new Error(`Cannot derive a worktree path from repo "${repo}" and branch "${branch}"`);
  }
  return path.join(WORKTREES_DIR, `${repoSegment}-${branchSegment}`);
}

/**
 * Create (or adopt) the worktree for `(repo, branch)`.
 *
 * Idempotent on the path, because the caller is a chat-driven action that will
 * be retried: an existing directory is reused rather than treated as a
 * collision. Also tolerates a branch that already exists — the second
 * `worktree add` drops `-b` and checks the branch out instead.
 *
 * @returns The worktree path.
 * @throws The git error, verbatim, when neither form of `worktree add` works.
 */
export function createWorktree(repo: string, branch: string): string {
  const target = worktreePath(repo, branch);
  if (fs.existsSync(target)) {
    log.info('Reusing existing worktree', { repo, branch, target });
    return target;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    git(repo, ['worktree', 'add', target, '-b', branch]);
  } catch (err) {
    // `-b` fails when the branch is already there. Checking it out is the same
    // intent, so retry — but only once, and let the second failure surface.
    log.info('Worktree branch already exists — checking it out instead', { repo, branch, err });
    git(repo, ['worktree', 'add', target, branch]);
  }
  log.info('Worktree created', { repo, branch, target });
  return target;
}

/**
 * The repository a worktree belongs to, by name.
 *
 * Asked of git rather than parsed back out of the worktree's directory name:
 * that name is `<repo>-<branch>` after `sanitizeSegment` has flattened both
 * halves, so a repo or branch containing a dash makes the split ambiguous and
 * the reader is told the wrong repository.
 *
 * `--git-common-dir` is the shared `.git` of the OWNING checkout, which is the
 * one thing a worktree always knows about its origin.
 *
 * @returns The repository directory's name, or the worktree's own basename when
 *   git cannot answer — a label is decoration, and losing it must never cost the
 *   listing it labels.
 */
export function worktreeRepoName(worktree: string): string {
  try {
    const commonDir = git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    if (commonDir) return path.basename(path.dirname(commonDir));
  } catch (err) {
    log.debug('Could not name the repository behind a worktree', { worktree, err });
  }
  return path.basename(worktree);
}

/**
 * The branch a worktree has checked out.
 *
 * @returns The branch name, or `'(detached)'` when git reports no branch and
 *   `'(unknown)'` when it will not answer at all. Both are labels — see
 *   `worktreeRepoName` on why a missing label never fails the listing.
 */
export function worktreeBranch(worktree: string): string {
  try {
    const branch = git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (!branch) return '(unknown)';
    return branch === 'HEAD' ? '(detached)' : branch;
  } catch (err) {
    log.debug('Could not name the branch a worktree has checked out', { worktree, err });
    return '(unknown)';
  }
}

/** Whether a worktree can be deleted without destroying anything. */
export interface WorktreeState {
  /** True only when deleting the directory would lose nothing at all. */
  clean: boolean;
  /** Why, in words a human reading the CLI output can act on. */
  reason: string;
}

/**
 * Can this worktree be deleted without destroying work?
 *
 * The default answer is NO, and every path that cannot prove otherwise returns
 * NO. Deleting an agent's uncommitted work is unrecoverable, while keeping a
 * directory that could have gone costs a few megabytes and one line of output,
 * so the two errors are not remotely comparable.
 *
 * Three things count as work:
 *
 * - **Uncommitted changes and untracked files.** `status --porcelain` reports
 *   both, which is why it is one call and not two. Ignored files (build output,
 *   `node_modules`) deliberately do not count — they are not work, and treating
 *   them as work would retain every worktree forever.
 * - **Commits that exist nowhere else.** Not "unpushed": the branch a worker
 *   gets has no upstream, so there is nothing to compare against. The real
 *   question is whether any commit would VANISH, and that is answered by asking
 *   git for the commits reachable from HEAD and from no other branch, remote or
 *   tag. `nanoclaw/*` branches are excluded from that set, so another worker's
 *   branch never counts as a safe home for these commits.
 * - **Anything git refuses to talk about.** A failed inspection is dirty, not
 *   clean.
 *
 * Note that `git worktree remove` does NOT delete the branch, so removing a
 * CLEAN worktree loses nothing even in hindsight: every commit is contained
 * elsewhere, and the ref survives for a later worktree to check out again.
 *
 * @param worktree The worktree path, as stored on `agent_groups.workspace_path`.
 */
export function inspectWorktree(worktree: string): WorktreeState {
  if (!fs.existsSync(worktree)) return { clean: true, reason: 'the worktree is already gone' };

  let status: string;
  try {
    status = git(worktree, ['status', '--porcelain']);
  } catch (err) {
    return { clean: false, reason: `git could not inspect it (${errText(err)})` };
  }
  const changed = status.split('\n').filter((line) => line.trim().length > 0);
  if (changed.length > 0) {
    // Split rather than totalled. "3 dirty files" tells a human nothing they
    // can act on; "2 uncommitted change(s), 1 untracked file(s)" tells them
    // whether to commit, to stash, or to delete a stray build artifact. The
    // `??` prefix is porcelain v1's untracked marker.
    const untracked = changed.filter((line) => line.startsWith('??')).length;
    const uncommitted = changed.length - untracked;
    const parts: string[] = [];
    if (uncommitted > 0) parts.push(`${uncommitted} uncommitted change(s)`);
    if (untracked > 0) parts.push(`${untracked} untracked file(s)`);
    return { clean: false, reason: parts.join(', ') };
  }

  let unmerged: number;
  try {
    // `--exclude` applies to the NEXT ref selector only, so it narrows
    // `--branches` and leaves `--remotes` and `--tags` whole. A worker branch
    // that was pushed therefore counts as contained, which is correct: the
    // commits survive the directory.
    const counted = git(worktree, [
      'rev-list',
      '--count',
      'HEAD',
      '--not',
      // `--exclude` strips the `refs/heads/` prefix before matching against
      // `--branches`, so the pattern is bare. Written as `refs/heads/…` it
      // matches nothing, the worker's OWN branch stays in the set, and every
      // worktree reads as clean — verified against git.
      '--exclude=nanoclaw/*',
      '--branches',
      '--remotes',
      '--tags',
    ]).trim();
    unmerged = Number.parseInt(counted, 10);
  } catch (err) {
    return { clean: false, reason: `git could not count its commits (${errText(err)})` };
  }
  if (!Number.isFinite(unmerged)) return { clean: false, reason: 'git did not report a commit count' };
  if (unmerged > 0) return { clean: false, reason: `${unmerged} commit(s) that exist nowhere else` };

  return { clean: true, reason: 'no uncommitted changes and no commits that exist nowhere else' };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0] : String(err);
}

/**
 * Remove a worktree, tolerating one that is already gone.
 *
 * NEVER forced, and there is no parameter that could force it. A worktree
 * holding uncommitted agent work must fail to remove and say so, rather than
 * have the work deleted on its behalf — git's own refusal is the second line of
 * defence behind `inspectWorktree`.
 *
 * @throws When git refuses. The caller is a human-run command, so a failure it
 *   could not see would be a lie about what was cleaned up.
 */
export function removeWorktree(worktree: string): void {
  if (!fs.existsSync(worktree)) return;
  try {
    // Run from inside the worktree: git finds the owning repository itself, so
    // the caller does not have to remember which repo this path belongs to.
    git(worktree, ['worktree', 'remove', worktree]);
    log.info('Worktree removed', { worktree });
  } catch (err) {
    log.warn('Failed to remove worktree — leaving it in place', { worktree, err });
    throw new Error(`git refused to remove ${worktree}: ${errText(err)}`, { cause: err });
  }
}

/** One worktree under `WORKTREES_DIR`, as `ncl worktrees list` reports it. */
export interface WorktreeEntry {
  /** Absolute path — the same string `agent_groups.workspace_path` carries. */
  path: string;
  /** Repository this worktree checks out, by directory name. */
  repo: string;
  /** Branch it has checked out. */
  branch: string;
  /** Whether removing it would destroy anything, and why. */
  state: WorktreeState;
}

/**
 * Every worktree under `WORKTREES_DIR`, inspected.
 *
 * Enumerated from the DIRECTORY rather than from `agent_groups`, because the
 * two disagree exactly when it matters: a worker group deleted with
 * `ncl groups delete` leaves its worktree behind, and a listing driven by the
 * table would never mention it again. Orphaned is not disposable — every entry
 * carries the same cleanliness proof.
 *
 * A missing `WORKTREES_DIR` is an empty list, not an error: no repo-scoped
 * worker has ever been created on this install.
 */
export function listWorktrees(): WorktreeEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(WORKTREES_DIR, { withFileTypes: true });
  } catch (err) {
    log.debug('No worktrees directory to list', { dir: WORKTREES_DIR, err });
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(WORKTREES_DIR, entry.name))
    .sort()
    .map((worktree) => ({
      path: worktree,
      repo: worktreeRepoName(worktree),
      branch: worktreeBranch(worktree),
      state: inspectWorktree(worktree),
    }));
}

/** Every git invocation, as argv. Never a shell string — see the module comment. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
