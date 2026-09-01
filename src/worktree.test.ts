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
  parseProjectRoots,
  removeWorktree,
  resolveRepo,
  sanitizeSegment,
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

  it('names the directory from the repo and branch', () => {
    expect(worktreePath('/a/b/saber', 'feat/x')).toBe(path.join(WORKTREES_DIR, 'saber-feat-x'));
  });

  it('refuses a repo or branch that sanitizes to nothing', () => {
    expect(() => worktreePath('/a/b/..', 'main')).toThrow(/Cannot derive a worktree path/);
    expect(() => worktreePath('/a/b/saber', '...')).toThrow(/Cannot derive a worktree path/);
  });
});

/**
 * These four touch the REAL `WORKTREES_DIR`, because `git worktree add` cannot
 * be faked and the constant is resolved from HOME at module load — the same
 * shape as `GROUPS_DIR` in config.ts. Kept safe by pid-namespaced branch names
 * and an afterEach that removes what it made, so a parallel run cannot collide
 * and a failed run leaves nothing behind.
 */
describe('createWorktree / removeWorktree', () => {
  let repo: string;
  let created: string | null;

  beforeEach(() => {
    repo = initRepo(path.join(tmp, 'saber'));
    created = null;
  });

  afterEach(() => {
    if (created) {
      removeWorktree(created);
      fs.rmSync(created, { recursive: true, force: true });
    }
  });

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

  /**
   * The relay label names the repository, and it is asked of git rather than
   * parsed out of the worktree's own directory name — that name is
   * `<repo>-<branch>` after both halves were flattened, so a dash in either one
   * makes the split ambiguous and the reader is told the wrong repository.
   */
  it('names the repository a worktree belongs to', () => {
    created = createWorktree(repo, `ncl-test-${process.pid}-name`);
    expect(worktreeRepoName(created)).toBe(path.basename(repo));
  });

  it('falls back to the path basename when git cannot answer', () => {
    // A label is decoration; losing it must never cost the message it labels.
    const notAWorktree = path.join(tmp, 'plain-dir');
    fs.mkdirSync(notAWorktree, { recursive: true });
    expect(worktreeRepoName(notAWorktree)).toBe('plain-dir');
  });

  /**
   * `inspectWorktree` is the only thing standing between the reaper and a
   * deleted day of someone's work, so every answer it can give is asserted
   * against real git rather than a mock.
   */
  describe('inspectWorktree', () => {
    function inWorktree(worktree: string, args: string[]): void {
      execFileSync('git', ['-C', worktree, ...args], { stdio: 'ignore' });
    }

    it('calls a fresh worktree clean', () => {
      created = createWorktree(repo, `ncl-test-${process.pid}-clean`);
      expect(inspectWorktree(created).clean).toBe(true);
    });

    it('calls an untracked file work', () => {
      created = createWorktree(repo, `ncl-test-${process.pid}-untracked`);
      fs.writeFileSync(path.join(created, 'notes.md'), 'half-finished\n');

      const state = inspectWorktree(created);
      expect(state.clean).toBe(false);
      expect(state.reason).toContain('uncommitted or untracked');
    });

    it('calls a modified tracked file work', () => {
      created = createWorktree(repo, `ncl-test-${process.pid}-modified`);
      fs.writeFileSync(path.join(created, 'README.md'), '# edited\n');

      expect(inspectWorktree(created).clean).toBe(false);
    });

    it('calls a commit that exists nowhere else work', () => {
      // `status --porcelain` is empty here. The danger is not dirt, it is a
      // commit that would be stranded — the branch has no upstream to compare
      // against, so the question is asked as "reachable from no other ref".
      created = createWorktree(repo, `nanoclaw/ncl-test-${process.pid}-unmerged`);
      fs.writeFileSync(path.join(created, 'feature.ts'), 'export const x = 1;\n');
      inWorktree(created, ['add', '.']);
      inWorktree(created, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-m', 'agent work']);

      const state = inspectWorktree(created);
      expect(state.clean).toBe(false);
      expect(state.reason).toContain('exist nowhere else');
    });

    it('calls a commit that another branch already holds safe', () => {
      created = createWorktree(repo, `nanoclaw/ncl-test-${process.pid}-merged`);
      fs.writeFileSync(path.join(created, 'feature.ts'), 'export const x = 1;\n');
      inWorktree(created, ['add', '.']);
      inWorktree(created, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-m', 'agent work']);
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
      // The one "clean" that means gone rather than empty — the reaper reads
      // this reason to tell removal from refusal.
      const state = inspectWorktree(path.join(tmp, 'never-existed'));
      expect(state).toEqual({ clean: true, reason: 'the worktree is already gone' });
    });
  });
});
