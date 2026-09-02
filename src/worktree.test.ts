/**
 * Repo resolution is a security boundary, not a lookup.
 *
 * A chat message names the repo, and the resolved path becomes the agent's
 * cwd — which is the ONE thing that decides whose `CLAUDE.md`,
 * `.claude/skills/` and `.claude/settings.json` get loaded. So every test here
 * that refuses something is testing a way a message could otherwise choose a
 * directory the operator never allowed.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorktree,
  inspectWorktree,
  listWorktrees,
  parseProjectRoots,
  removeWorktree,
  resolveRepo,
  sanitizeSegment,
  worktreeBranch,
  worktreePath,
  worktreeRepoName,
  WORKTREES_DIR,
} from './worktree.js';

let tmp: string;

/** A real git repository — `worktree add` cannot be faked. */
function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const run = (args: string[]): void => void execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  run(['add', '.']);
  run(['commit', '-m', 'init']);
  return dir;
}

beforeEach(() => {
  // realpath: macOS hands out /var/... symlinks into /private/var, and this
  // module resolves symlinks by design — an unresolved fixture root would make
  // every containment assertion pass or fail for the wrong reason.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-worktree-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('parseProjectRoots', () => {
  it('is empty by default, which is the feature being off', () => {
    expect(parseProjectRoots('')).toEqual([]);
    expect(parseProjectRoots('   ')).toEqual([]);
  });

  it('splits on the platform delimiter and resolves each entry', () => {
    const roots = parseProjectRoots(['/a/b', '/c/d'].join(path.delimiter));
    expect(roots).toEqual([path.resolve('/a/b'), path.resolve('/c/d')]);
  });

  it('drops empty entries left by a trailing or doubled delimiter', () => {
    expect(parseProjectRoots(`${path.delimiter}/a${path.delimiter}${path.delimiter}`)).toEqual([path.resolve('/a')]);
  });
});

describe('resolveRepo', () => {
  it('resolves a repository by name under an allowed root', () => {
    const repo = initRepo(path.join(tmp, 'roots', 'saber'));
    expect(resolveRepo('saber', [path.join(tmp, 'roots')])).toBe(repo);
  });

  it('resolves a nested name, so a two-level layout still works', () => {
    const repo = initRepo(path.join(tmp, 'roots', 'wego', 'saber'));
    expect(resolveRepo('wego/saber', [path.join(tmp, 'roots')])).toBe(repo);
  });

  it('searches every root and names them all when it finds nothing', () => {
    const repo = initRepo(path.join(tmp, 'second', 'saber'));
    const roots = [path.join(tmp, 'first'), path.join(tmp, 'second')];
    fs.mkdirSync(roots[0], { recursive: true });

    expect(resolveRepo('saber', roots)).toBe(repo);
    expect(() => resolveRepo('absent', roots)).toThrow(/no git repository/);
    expect(() => resolveRepo('absent', roots)).toThrow(new RegExp(roots[1]));
  });

  it('refuses everything when no roots are configured', () => {
    // The default. Without this the feature would be on for every install.
    expect(() => resolveRepo('saber', [])).toThrow(/no project roots are configured/);
  });

  it('refuses an absolute path, which would bypass the allowlist entirely', () => {
    const repo = initRepo(path.join(tmp, 'roots', 'saber'));
    expect(() => resolveRepo(repo, [path.join(tmp, 'roots')])).toThrow(/never by absolute path/);
  });

  it('refuses a home-relative path for the same reason', () => {
    expect(() => resolveRepo('~/secrets', [path.join(tmp, 'roots')])).toThrow(/never by absolute path/);
  });

  it('refuses traversal out of the root', () => {
    initRepo(path.join(tmp, 'elsewhere'));
    fs.mkdirSync(path.join(tmp, 'roots'), { recursive: true });
    expect(() => resolveRepo('../elsewhere', [path.join(tmp, 'roots')])).toThrow(/may not contain/);
  });

  it('refuses traversal hidden in the middle of a name', () => {
    fs.mkdirSync(path.join(tmp, 'roots'), { recursive: true });
    expect(() => resolveRepo('a/../../elsewhere', [path.join(tmp, 'roots')])).toThrow(/may not contain/);
  });

  it('refuses a symlink that points out of the root', () => {
    // The one traversal a lexical check cannot see: the NAME is clean and the
    // unresolved path is inside the root. Only realpath tells the truth.
    const outside = initRepo(path.join(tmp, 'outside', 'secret'));
    const root = path.join(tmp, 'roots');
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'sneaky'));

    expect(() => resolveRepo('sneaky', [root])).toThrow(/outside the allowed roots/);
  });

  it('accepts a symlink that stays inside the root', () => {
    const repo = initRepo(path.join(tmp, 'roots', 'saber'));
    const root = path.join(tmp, 'roots');
    fs.symlinkSync(repo, path.join(root, 'alias'));

    expect(resolveRepo('alias', [root])).toBe(repo);
  });

  it('refuses a path that is not a directory', () => {
    const root = path.join(tmp, 'roots');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'notes.md'), 'hi');

    expect(() => resolveRepo('notes.md', [root])).toThrow(/is not a directory/);
  });

  it('refuses a directory that is not a git repository', () => {
    const root = path.join(tmp, 'roots');
    fs.mkdirSync(path.join(root, 'plain'), { recursive: true });

    expect(() => resolveRepo('plain', [root])).toThrow(/is not a git repository/);
  });

  it('refuses a subdirectory of a repository, which is not a repo root', () => {
    // `git rev-parse` would accept this; a repo root is what a worktree needs.
    const repo = initRepo(path.join(tmp, 'roots', 'saber'));
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });

    expect(() => resolveRepo('saber/src', [path.join(tmp, 'roots')])).toThrow(/is not a git repository/);
  });

  it('refuses an empty name', () => {
    expect(() => resolveRepo('  ', [path.join(tmp, 'roots')])).toThrow(/required/);
  });

  it('ignores a configured root that does not exist rather than reporting it as the problem', () => {
    const repo = initRepo(path.join(tmp, 'real', 'saber'));
    expect(resolveRepo('saber', [path.join(tmp, 'gone'), path.join(tmp, 'real')])).toBe(repo);
  });
});

describe('sanitizeSegment', () => {
  it('replaces path separators so a branch name cannot become a directory', () => {
    expect(sanitizeSegment('feat/multi-repo')).toBe('feat-multi-repo');
  });

  it('cannot produce a traversal segment', () => {
    expect(sanitizeSegment('..')).toBe('');
    expect(sanitizeSegment('../..')).toBe('');
    expect(sanitizeSegment('.hidden')).toBe('hidden');
  });

  it('collapses runs and keeps ordinary characters', () => {
    expect(sanitizeSegment('a  b//c')).toBe('a-b-c');
    expect(sanitizeSegment('saber_v2.1')).toBe('saber_v2.1');
  });
});

describe('worktreePath', () => {
  it('places the worktree OUTSIDE the repository', () => {
    // Load-bearing: the memory walk climbs past a worktree into its parent
    // checkout, so a worktree inside the repo loads the outer checkout's
    // CLAUDE.md on top of its own — the 11,618-token leak of 5a592b62.
    const repo = '/Users/kien/IdeaProjects/wego/saber';
    const result = worktreePath(repo, 'feat/x');

    expect(result.startsWith(WORKTREES_DIR + path.sep)).toBe(true);
    expect(result.startsWith(repo)).toBe(false);
  });

  it('names the directory from the repo, a fingerprint of its path, and the branch', () => {
    const derived = worktreePath('/a/b/saber', 'feat/x');
    expect(path.dirname(derived)).toBe(WORKTREES_DIR);
    expect(path.basename(derived)).toMatch(/^saber-[0-9a-f]{8}-feat-x$/);
  });

  it('gives two repositories with the SAME basename different worktrees', () => {
    // The bug the fingerprint exists to close. `resolveRepo` accepts a name
    // with separators and searches EVERY allowed root, so `wego/saber` and
    // `kien/saber` are two repositories a basename key collapses into one
    // directory — after which `createWorktree` adopts the first one's worktree
    // and `findWorkerForOrigin` answers with the first one's worker, reported
    // to the agent as a reuse. Same branch on purpose: one thread, two repos.
    expect(worktreePath('/roots/wego/saber', 'nanoclaw/sess-1')).not.toBe(
      worktreePath('/roots/kien/saber', 'nanoclaw/sess-1'),
    );
  });

  it('gives one repository ONE worktree however its path is spelled', () => {
    // The mirror of the test above, and why the fingerprint canonicalizes
    // instead of hashing the string it was handed. Splitting one repository
    // across two worktrees is the same failure seen from the other side: two
    // branches, and a second worker that cannot see the first one's work.
    const real = fs.realpathSync(initRepo(path.join(tmp, 'canon')));
    const linkDir = path.join(tmp, 'via-link');
    fs.mkdirSync(linkDir, { recursive: true });
    // Same BASENAME, different path — so only the fingerprint can tell the
    // readable segment's job from the identity's.
    const link = path.join(linkDir, 'canon');
    fs.symlinkSync(real, link);

    expect(worktreePath(link, 'main')).toBe(worktreePath(real, 'main'));
    expect(worktreePath(`${real}/`, 'main')).toBe(worktreePath(real, 'main'));
  });

  it('refuses a repo or branch that sanitizes to nothing', () => {
    expect(() => worktreePath('/a/b/..', 'main')).toThrow(/Cannot derive a worktree path/);
    expect(() => worktreePath('/a/b/saber', '...')).toThrow(/Cannot derive a worktree path/);
  });
});

/**
 * These touch the REAL `WORKTREES_DIR`, because `git worktree add` cannot be
 * faked and the constant is resolved from HOME at module load — the same shape
 * as `GROUPS_DIR` in config.ts. Kept safe by pid-namespaced branch names and an
 * afterEach that removes what it made, so a parallel run cannot collide and a
 * failed run leaves nothing behind. Nothing here removes a worktree it did not
 * create.
 */
describe('createWorktree / removeWorktree', () => {
  let repo: string;
  let created: string | null;

  beforeEach(() => {
    repo = initRepo(path.join(tmp, 'saber'));
    created = null;
  });

  afterEach(() => {
    if (created) fs.rmSync(created, { recursive: true, force: true });
  });

  /** Commit everything in a worktree, with an identity the fixture supplies. */
  function commitIn(worktree: string, message: string): void {
    const run = (args: string[]): void => void execFileSync('git', ['-C', worktree, ...args], { stdio: 'ignore' });
    run(['add', '.']);
    run(['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-m', message]);
  }

  it('creates a worktree on a new branch, outside the repository', () => {
    created = createWorktree(repo, `ncl-test-${process.pid}-a`);

    expect(fs.existsSync(path.join(created, 'README.md'))).toBe(true);
    expect(created.startsWith(repo)).toBe(false);
  });

  it('is idempotent — a second call adopts the existing worktree', () => {
    const branch = `ncl-test-${process.pid}-b`;
    created = createWorktree(repo, branch);
    fs.writeFileSync(path.join(created, 'scratch.txt'), 'work in progress');

    expect(createWorktree(repo, branch)).toBe(created);
    // Adopted, not recreated: the agent's in-flight work survives a retry.
    expect(fs.existsSync(path.join(created, 'scratch.txt'))).toBe(true);
  });

  it('checks out a branch that already exists instead of failing', () => {
    const branch = `ncl-test-${process.pid}-c`;
    execFileSync('git', ['-C', repo, 'branch', branch], { stdio: 'ignore' });

    created = createWorktree(repo, branch);
    expect(fs.existsSync(created)).toBe(true);
  });

  it('removes a worktree', () => {
    const worktree = createWorktree(repo, `ncl-test-${process.pid}-d`);
    removeWorktree(worktree);
    expect(fs.existsSync(worktree)).toBe(false);
  });

  it('tolerates removing a path that is already gone', () => {
    expect(() => removeWorktree(path.join(tmp, 'never-existed'))).not.toThrow();
  });

  it('throws rather than reporting a removal git refused', () => {
    // `ncl worktrees prune` prints what it removed. A swallowed failure would
    // make that report a lie, so the refusal has to reach the caller.
    const notAWorktree = path.join(tmp, 'plain-dir');
    fs.mkdirSync(notAWorktree, { recursive: true });
    expect(() => removeWorktree(notAWorktree)).toThrow(/git refused to remove/);
    expect(fs.existsSync(notAWorktree)).toBe(true);
  });

  /**
   * The listing label names the repository, and it is asked of git rather than
   * parsed out of the worktree's own directory name — that name is
   * `<repo>-<branch>` after both halves were flattened, so a dash in either one
   * makes the split ambiguous and the reader is told the wrong repository.
   */
  it('names the repository a worktree belongs to', () => {
    created = createWorktree(repo, `ncl-test-${process.pid}-name`);
    expect(worktreeRepoName(created)).toBe(path.basename(repo));
  });

  it('falls back to the path basename when git cannot answer', () => {
    // A label is decoration; losing it must never cost the listing it labels.
    const notAWorktree = path.join(tmp, 'plain-dir-2');
    fs.mkdirSync(notAWorktree, { recursive: true });
    expect(worktreeRepoName(notAWorktree)).toBe('plain-dir-2');
  });

  it('names the branch a worktree has checked out, and says so when it cannot', () => {
    const branch = `nanoclaw/ncl-test-${process.pid}-branch`;
    created = createWorktree(repo, branch);
    expect(worktreeBranch(created)).toBe(branch);

    const notAWorktree = path.join(tmp, 'plain-dir-3');
    fs.mkdirSync(notAWorktree, { recursive: true });
    expect(worktreeBranch(notAWorktree)).toBe('(unknown)');
  });

  /**
   * `inspectWorktree` is the only thing standing between `ncl worktrees prune`
   * and a deleted day of someone's work, so every answer it can give is
   * asserted against real git rather than a mock.
   */
  describe('inspectWorktree', () => {
    it('calls a fresh worktree clean', () => {
      created = createWorktree(repo, `ncl-test-${process.pid}-clean`);
      expect(inspectWorktree(created).clean).toBe(true);
    });

    it('calls an untracked file work, and says it is untracked', () => {
      created = createWorktree(repo, `ncl-test-${process.pid}-untracked`);
      fs.writeFileSync(path.join(created, 'notes.md'), 'half-finished\n');

      const state = inspectWorktree(created);
      expect(state.clean).toBe(false);
      // "dirty" alone is not actionable: the operator has to know whether to
      // commit it or delete a stray file.
      expect(state.reason).toContain('1 untracked file(s)');
      expect(state.reason).not.toContain('uncommitted change');
    });

    it('calls a modified tracked file work, and says it is uncommitted', () => {
      created = createWorktree(repo, `ncl-test-${process.pid}-modified`);
      fs.writeFileSync(path.join(created, 'README.md'), '# edited\n');

      const state = inspectWorktree(created);
      expect(state.clean).toBe(false);
      expect(state.reason).toContain('1 uncommitted change(s)');
      expect(state.reason).not.toContain('untracked');
    });

    it('names both when a worktree holds both', () => {
      created = createWorktree(repo, `ncl-test-${process.pid}-both`);
      fs.writeFileSync(path.join(created, 'README.md'), '# edited\n');
      fs.writeFileSync(path.join(created, 'notes.md'), 'half-finished\n');

      const state = inspectWorktree(created);
      expect(state.reason).toContain('1 uncommitted change(s)');
      expect(state.reason).toContain('1 untracked file(s)');
    });

    /**
     * REGRESSION GUARD for the `--exclude` prefix.
     *
     * git strips `refs/heads/` before matching `--branches`, so the pattern
     * must be bare `nanoclaw/*`. Written as `refs/heads/nanoclaw/*` it matches
     * nothing, the worker's OWN branch stays in the comparison set, HEAD is
     * reachable from it, and EVERY worktree reads as clean — including this
     * one, which holds a commit that exists nowhere else. The branch here is
     * deliberately under `nanoclaw/`: with any other name the exclude is not
     * exercised and the bug hides.
     */
    it('calls a commit that exists nowhere else work', () => {
      // `status --porcelain` is empty here. The danger is not dirt, it is a
      // commit that would be stranded — the branch has no upstream to compare
      // against, so the question is asked as "reachable from no other ref".
      created = createWorktree(repo, `nanoclaw/ncl-test-${process.pid}-unmerged`);
      fs.writeFileSync(path.join(created, 'feature.ts'), 'export const x = 1;\n');
      commitIn(created, 'agent work');

      const state = inspectWorktree(created);
      expect(state.clean).toBe(false);
      expect(state.reason).toContain('exist nowhere else');
    });

    it('calls a commit that another branch already holds safe', () => {
      created = createWorktree(repo, `nanoclaw/ncl-test-${process.pid}-merged`);
      fs.writeFileSync(path.join(created, 'feature.ts'), 'export const x = 1;\n');
      commitIn(created, 'agent work');
      // Someone merged it. Nothing would be lost by deleting the directory.
      execFileSync('git', ['-C', repo, 'branch', `keeper-${process.pid}`, 'HEAD'], { stdio: 'ignore' });
      execFileSync('git', ['-C', repo, 'fetch', created, `+HEAD:refs/heads/kept-${process.pid}`], { stdio: 'ignore' });

      expect(inspectWorktree(created).clean).toBe(true);
    });

    it('calls a path git cannot inspect NOT clean', () => {
      // A failed inspection is dirty. Proving safety is the only thing that
      // authorizes a delete.
      const plain = path.join(tmp, 'not-a-repo');
      fs.mkdirSync(plain, { recursive: true });
      expect(inspectWorktree(plain).clean).toBe(false);
    });

    it('calls an absent worktree clean, and says so exactly', () => {
      // The one "clean" that means gone rather than empty — callers read this
      // reason to tell removal from refusal.
      const state = inspectWorktree(path.join(tmp, 'never-existed'));
      expect(state).toEqual({ clean: true, reason: 'the worktree is already gone' });
    });
  });

  /**
   * `listWorktrees` reads the DIRECTORY, so these assertions look for the
   * fixture's own entry among whatever else the machine holds. Nothing here
   * mutates a worktree it did not create.
   */
  describe('listWorktrees', () => {
    it('reports a worktree it finds on disk, with its repo, branch and state', () => {
      const branch = `nanoclaw/ncl-test-${process.pid}-list`;
      created = createWorktree(repo, branch);

      const entry = listWorktrees().find((candidate) => candidate.path === created);
      expect(entry).toBeDefined();
      expect(entry?.repo).toBe(path.basename(repo));
      expect(entry?.branch).toBe(branch);
      expect(entry?.state.clean).toBe(true);
    });

    it('reports a dirty worktree as dirty', () => {
      created = createWorktree(repo, `ncl-test-${process.pid}-list-dirty`);
      fs.writeFileSync(path.join(created, 'notes.md'), 'half-finished\n');

      const entry = listWorktrees().find((candidate) => candidate.path === created);
      expect(entry?.state.clean).toBe(false);
      expect(entry?.state.reason).toContain('untracked');
    });
  });
});

/**
 * A worker branches from the REMOTE default branch, not from whatever the
 * owning checkout's HEAD happened to be.
 *
 * The old behaviour was silent in the way that costs the most: the worktree is
 * created, the agent works in it, and a `main` that was weeks stale only
 * surfaces as a conflict at merge time. So the assertion is end-to-end against
 * real git — a commit that exists ONLY on the remote must be present in the
 * worktree, which is possible only if `createWorktree` fetched first.
 */
describe('createWorktree base ref', () => {
  let created: string | null;

  beforeEach(() => {
    created = null;
  });

  afterEach(() => {
    if (created) fs.rmSync(created, { recursive: true, force: true });
  });

  /** A clone whose local `main` is one commit behind its origin, unfetched. */
  function initStaleClone(): { repo: string; freshFile: string } {
    const seed = initRepo(path.join(tmp, 'seed'));
    const origin = path.join(tmp, 'origin.git');
    const run = (cwd: string, args: string[]): void =>
      void execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });

    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
    run(seed, ['remote', 'add', 'origin', origin]);
    run(seed, ['push', '-u', 'origin', 'main']);

    const repo = path.join(tmp, 'clone');
    execFileSync('git', ['clone', origin, repo], { stdio: 'ignore' });

    // Advance the remote AFTER the clone, and never fetch in `repo`.
    fs.writeFileSync(path.join(seed, 'fresh.txt'), 'only on origin\n');
    run(seed, ['add', '.']);
    run(seed, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-m', 'fresh']);
    run(seed, ['push', 'origin', 'main']);

    return { repo, freshFile: 'fresh.txt' };
  }

  it('fetches origin and branches from the remote default branch', () => {
    const { repo, freshFile } = initStaleClone();
    // Precondition: the commit is genuinely absent locally, so a pass cannot
    // come from the clone having had it all along.
    expect(fs.existsSync(path.join(repo, freshFile))).toBe(false);

    created = createWorktree(repo, `ncl-test-${process.pid}-baseref`);

    expect(fs.existsSync(path.join(created, freshFile))).toBe(true);
  });

  /**
   * `git worktree add -b <branch> origin/main` makes git DWIM an upstream:
   * it writes branch.<name>.merge = refs/heads/main. A worker running
   * `git push` under push.default=upstream would then push onto main. The
   * no-base form set no upstream, and passing a base must not change that.
   */
  it('does not set an upstream on the worker branch', () => {
    const { repo } = initStaleClone();
    const branch = `ncl-test-${process.pid}-notrack`;

    created = createWorktree(repo, branch);

    const upstream = (): string => {
      try {
        return execFileSync('git', ['-C', created as string, 'config', '--get', `branch.${branch}.merge`], {
          encoding: 'utf-8',
        }).trim();
      } catch {
        // `git config --get` exits 1 when the key is absent, which is the pass.
        return '';
      }
    };

    expect(upstream()).toBe('');
  });

  it('still creates a worktree when the repository has no origin', () => {
    // A laptop offline, or a repo that was never pushed. Degrading to local
    // HEAD is correct; refusing to spawn the worker is not.
    const repo = initRepo(path.join(tmp, 'no-origin'));

    created = createWorktree(repo, `ncl-test-${process.pid}-noorigin`);

    expect(fs.existsSync(path.join(created, 'README.md'))).toBe(true);
  });
});
