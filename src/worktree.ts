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
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { WORKTREES_DIR } from './home.js';
import { log } from './log.js';

/**
 * Where worktrees are created: one tree under the host home.
 *
 * The path is not what matters — the property is. No ancestor of it holds a
 * `CLAUDE.md`. See the module comment on the upward walk: a worktree inside its
 * target checkout loads the outer checkout's guidance on top of its own.
 *
 * Re-exported because callers have always imported it from here.
 */
export { WORKTREES_DIR };

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

  // Both of these mean "you named the wrong thing", which is the one case a
  // caller can act on — so they carry the names that would have worked.
  if (rejection) {
    throw new Error(`Cannot resolve repo "${requested}": ${rejection.reason}. ${availableRepos(roots)}`);
  }
  throw new Error(
    `Cannot resolve repo "${requested}": no git repository by that name under any allowed root. ` +
      `${availableRepos(roots)}`,
  );
}

/**
 * How many repository names a refusal will list.
 *
 * A ceiling rather than a page: the list exists so a caller can retry with a
 * real name, and a caller that needs to read past forty names is not choosing
 * from a list, it is searching — which `ncl` is for.
 */
const SUGGESTION_LIMIT = 40;

/**
 * How deep under a root a repository is looked for when LISTING.
 *
 * Two, because that is the shape the tool documents: `saber` and `wego/saber`.
 * `resolveRepo` itself accepts any depth, so a repository nested deeper stays
 * resolvable by name and simply will not appear in a refusal — the asymmetry
 * is deliberate, since walking an unbounded tree to write an error message
 * would make the failure path slower than the success path.
 */
const SUGGESTION_DEPTH = 2;

/**
 * The repository names that WOULD resolve, for a refusal to offer.
 *
 * A refusal that names only the roots leaves a caller no move but to guess
 * again, and an agent that guesses a repository name twice has burned two
 * turns to learn one fact. Naming what exists turns a dead end into a retry.
 *
 * WHAT THIS DISCLOSES, DELIBERATELY. The refusal is relayed into the
 * container and usually onward into chat, so every repository name under
 * `NANOCLAW_PROJECT_ROOTS` becomes visible to anyone who can talk to the
 * agent — which includes non-admin members of a group chat, since
 * `spawn_worker` needs no approval. That is accepted: the allowlist is an
 * operator's list of checkouts on their own machine, names only, no paths and
 * no contents, and an agent that cannot name a repository cannot delegate at
 * all. An install whose repository NAMES are themselves sensitive should keep
 * those checkouts outside the allowlist, which also stops a worker standing
 * in them.
 *
 * Never throws: this runs while an error is already being built, and a second
 * failure here would replace a precise refusal with a stack trace. An
 * unreadable root contributes nothing and is skipped.
 */
export function listResolvableRepos(roots: readonly string[]): string[] {
  const names = new Set<string>();

  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > SUGGESTION_DEPTH || names.size >= SUGGESTION_LIMIT) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (names.size >= SUGGESTION_LIMIT) return;
      // `isDirectory()` is false for a symlinked checkout, which is a normal
      // way to lay one out — so follow the link and ask what it points at.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const child = path.join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      let isDir = false;
      try {
        isDir = fs.statSync(child).isDirectory();
      } catch {
        continue; // a broken symlink names nothing
      }
      if (!isDir) continue;
      if (isGitRepositoryRoot(child)) {
        // A repository does not contain the repositories we would offer, so
        // stop here rather than descending into submodules and vendored trees.
        names.add(name);
        continue;
      }
      walk(child, name, depth + 1);
    }
  };

  for (const root of roots) walk(root, '', 1);
  return [...names].sort();
}

/** The tail of a refusal: the roots, and what actually resolves under them. */
function availableRepos(roots: readonly string[]): string {
  const rootList = `Allowed roots: ${roots.join(', ')}`;
  const names = listResolvableRepos(roots);
  if (names.length === 0) return `${rootList}. No git repository was found under any of them.`;
  const shown = names.join(', ');
  const more = names.length >= SUGGESTION_LIMIT ? ', … (list truncated)' : '';
  return `${rootList}. Repositories you can name: ${shown}${more}`;
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
 * Eight hex characters of sha256 over the resolved repository path.
 *
 * The basename alone cannot key a worktree. `resolveRepo` accepts a name with
 * separators and searches EVERY allowed root, so `wego/saber` and `kien/saber`
 * — or one `saber` under each of two roots — are different repositories with
 * the same basename. Keyed on basename they collide into one directory, and
 * because `createWorktree` adopts an existing directory and
 * `findWorkerForOrigin` looks up by `workspace_path`, the second request is
 * answered with the FIRST repository's worker, reported as a reuse. A worker
 * standing in the wrong repository is indistinguishable from a working one.
 *
 * CANONICALIZED first, so one physical repository has exactly one fingerprint
 * however it was named. `path.resolve` alone is not enough: it collapses `..`
 * and a trailing slash but leaves symlinks intact, and on macOS `/tmp` is a
 * symlink to `/private/tmp` — so the same checkout reached by two names would
 * hash differently and get two worktrees. `realpathSync` throws for a path
 * that is not there, which is not this function's business to report, so that
 * case falls back to `path.resolve` and lets `createWorktree` fail with git's
 * own message.
 */
function repoFingerprint(repo: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync(repo);
  } catch {
    canonical = path.resolve(repo);
  }
  return createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

/**
 * Where the worktree for `(repo, branch)` goes.
 *
 * OUTSIDE the repository, always. See the module comment: a worktree nested in
 * its own checkout inherits the outer checkout's `CLAUDE.md` through the same
 * upward walk that gives it its own.
 *
 * The basename stays in the name for a human reading `ls`, but the FINGERPRINT
 * is what makes the path unique — see `repoFingerprint`. Nothing parses this
 * name back into a repo or a branch: `worktreeRepoName` asks git through
 * `--git-common-dir` and `worktreeBranch` asks `rev-parse`, so the format is
 * free to change.
 *
 * @throws When repo or branch sanitize to nothing (a name of pure punctuation).
 */
export function worktreePath(repo: string, branch: string): string {
  const repoSegment = sanitizeSegment(path.basename(repo));
  const branchSegment = sanitizeSegment(branch);
  if (!repoSegment || !branchSegment) {
    throw new Error(`Cannot derive a worktree path from repo "${repo}" and branch "${branch}"`);
  }
  return path.join(WORKTREES_DIR, `${repoSegment}-${repoFingerprint(repo)}-${branchSegment}`);
}

/**
 * How long a graph reindex may take before a worker spawn gives up on it.
 *
 * A worker is spawned from a chat message and somebody is waiting for it, so
 * this is a responsiveness budget, not a correctness one — an incremental
 * update that overruns it is abandoned and the previous graph is left in place.
 */
/**
 * How long `git fetch` may take before a worker spawn gives up on it.
 *
 * Shorter than the reindex budget on purpose. A reindex is local work that
 * finishes; a fetch can block on a prompt or an unreachable host, and it runs
 * on the host's only thread.
 */
const FETCH_TIMEOUT_MS = 30_000;

const GRAPH_REINDEX_TIMEOUT_MS = 120_000;

/**
 * Fetch `origin` and name the ref a new worktree should branch from.
 *
 * A worker used to branch from whatever `repo`'s HEAD happened to be: a `main`
 * last pulled weeks ago, or somebody's half-finished feature branch. That fails
 * silently — the worktree is created, the agent works, and the wrong base only
 * surfaces as a conflict at merge time.
 *
 * Best-effort by design, and it never throws. A laptop with no network, a
 * repository with no `origin`, and a fetch that fails on credentials must all
 * still produce a worktree, so every failure degrades to "branch from HEAD"
 * with a log line saying so.
 *
 * @returns The ref to branch from, or null to let git use HEAD.
 */
function refreshAndResolveBaseRef(repo: string): string | null {
  try {
    // Bounded and non-interactive, unlike the other git calls in this module.
    // This is the one that reaches the network, and `createWorktree` runs
    // synchronously inside the single host process — so a credential helper
    // that prompts, or a host that black-holes the connection, would stall
    // every group's messages, not just this spawn.
    execFileSync('git', ['-C', repo, 'fetch', 'origin', '--quiet'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: FETCH_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' },
    });
  } catch (err) {
    log.warn('Worktree base: fetch failed, branching from local HEAD', { repo, err });
    return null;
  }

  // `origin/HEAD` is the honest answer and is what a fresh clone sets. It is
  // absent often enough to need fallbacks: `git remote set-head` is never run
  // by most tooling, and a repo added as a second remote never gets one.
  for (const ref of ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master']) {
    try {
      const resolved = git(repo, ['rev-parse', '--abbrev-ref', ref]).trim();
      if (resolved) return resolved;
    } catch {
      // Probing the next candidate. The miss is reported once, below, rather
      // than three times here.
    }
  }

  log.warn('Worktree base: origin has no HEAD, main or master; branching from local HEAD', { repo });
  return null;
}

/** A commit sha, or null when the ref does not resolve. Never throws. */
function revParseOrNull(repo: string, ref: string): string | null {
  try {
    return git(repo, ['rev-parse', ref]).trim() || null;
  } catch {
    // An unresolvable ref is a reason to skip a comparison, not to fail a spawn.
    return null;
  }
}

/**
 * Bring the owning checkout's code graph up to date.
 *
 * Worktrees do not carry a graph. `.code-review-graph/` is entirely untracked
 * (its own `.gitignore` is `*`) and `graph.db` stores ABSOLUTE paths, so a copy
 * placed in a worktree would describe the checkout it came from. Every worktree
 * therefore reads the owning checkout's graph, and that one graph is what this
 * keeps current.
 *
 * Deliberately `update` and never `build`. An incremental update on a repo with
 * no prior full build indexes only the changed files and then answers
 * confidently: "no callers", "no tests", for everything it never parsed. A
 * missing graph is a visible nothing; a partial graph is a plausible lie. So a
 * repo with no graph is left alone and the operator is told to build it once.
 *
 * Best-effort and never throws, for the same reason as the fetch above: a
 * missing binary or a slow index must not stop a worker from spawning. A repo
 * with no graph is skipped below, which is the only case an off-switch ever
 * served.
 */
function reindexCodeGraph(repo: string, base: string | null): void {
  if (!fs.existsSync(path.join(repo, '.code-review-graph', 'graph.db'))) {
    log.info('Worktree base: no code graph in the owning checkout, skipping reindex', {
      repo,
      hint: 'run `code-review-graph build` in the repository once to enable it',
    });
    return;
  }

  // The indexer reads the owning checkout's WORKING TREE, which sits at that
  // checkout's own HEAD. The new worktree is branched from `base`. When the two
  // differ — which is exactly the stale-checkout case this function exists to
  // serve — indexing would describe code the worker is not looking at. A graph
  // that describes the wrong tree is the same plausible lie as a partial one,
  // so leave the previous graph alone and say why.
  if (base) {
    const head = revParseOrNull(repo, 'HEAD');
    const baseSha = revParseOrNull(repo, base);
    if (head && baseSha && head !== baseSha) {
      log.info('Worktree base: owning checkout is not at the base ref, skipping reindex', {
        repo,
        base,
        head,
        baseSha,
        hint: 'indexing here would describe a different tree than the worktree gets',
      });
      return;
    }
  }

  try {
    execFileSync('code-review-graph', ['update'], {
      cwd: repo,
      encoding: 'utf-8',
      // stdout is per-file progress and is discarded rather than captured:
      // buffering it caps the child at Node's 1 MB default, and a large repo
      // would be killed with ENOBUFS part-way through writing the graph.
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: GRAPH_REINDEX_TIMEOUT_MS,
    });
    log.info('Worktree base: code graph reindexed', { repo });
  } catch (err) {
    log.warn('Worktree base: code graph reindex failed, serving the previous graph', { repo, err });
  }
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

  // Refresh the owning checkout, then reindex its graph, BEFORE branching. Both
  // steps act on `repo` and neither touches `target`, so the order is a
  // statement of intent rather than a constraint: an agent that starts in the
  // new worktree finds an up-to-date base and a graph that describes it.
  const base = refreshAndResolveBaseRef(repo);
  reindexCodeGraph(repo, base);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    // `--no-track` because `-b <branch> origin/main` makes git DWIM an
    // upstream: it sets branch.<name>.merge to refs/heads/main, so a worker
    // running `git push` under push.default=upstream would push onto main.
    // The no-base form set no upstream, and that property is preserved here.
    git(repo, ['worktree', 'add', target, '-b', branch, ...(base ? ['--no-track', base] : [])]);
  } catch (err) {
    // Usually the branch already exists, and checking it out is the same
    // intent. It is no longer the only cause: `base` was resolved a moment ago
    // and can be pruned or renamed before it is used, so the log names both
    // possibilities rather than asserting the common one. Retry once, and let
    // the second failure surface.
    log.info('Worktree add failed; retrying without a base ref', {
      repo,
      branch,
      base: base ?? 'HEAD',
      likely: 'the branch already exists, or the base ref went away',
      err,
    });
    git(repo, ['worktree', 'add', target, branch]);
  }
  log.info('Worktree created', { repo, branch, target, base: base ?? 'HEAD' });
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
