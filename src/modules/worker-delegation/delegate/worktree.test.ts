/**
 * Against a real git repository, because git is what enforces A8.
 *
 * A mocked git would assert that this file calls the commands it already
 * visibly calls. The properties worth pinning — one worktree per session, a
 * second call adopting the first, a refusal that carries no host path — are
 * all properties of git's own behaviour.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `WORKTREES_DIR` is derived once at module load, so the workspace root has to
// be set before the import below — not mocked. Replacing the whole module
// would starve its other importers of the roots they read at load too.
const { workspaceRoot } = vi.hoisted(() => {
  const tmpRoot = (process.env.TMPDIR || '/tmp').replace(/\/+$/, '');
  const root = `${tmpRoot}/nanoclaw-worktree-test-${process.pid}`;
  process.env.NANOCLAW_WORKSPACE_DIR = root;
  return { workspaceRoot: root };
});

const { ensureWorktree, WorktreeError, workerBranchName } = await import('./worktree.js');

let tmp: string;
let repoPath: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

beforeEach(() => {
  // The workspace root is fixed for the file, so each test starts from an empty
  // one — otherwise a session id reused across tests adopts the last one's copy.
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-worktree-'));
  repoPath = path.join(tmp, 'nanoclaw');
  fs.mkdirSync(repoPath, { recursive: true });

  git(repoPath, ['init', '--quiet']);
  git(repoPath, ['config', 'user.name', 'Test Operator']);
  git(repoPath, ['config', 'user.email', 'operator@example.com']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# repo\n');
  git(repoPath, ['add', 'README.md']);
  git(repoPath, ['commit', '--quiet', '-m', 'initial']);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('ensureWorktree', () => {
  it('creates a working copy on a branch named for the session (A8)', () => {
    const handle = ensureWorktree(repoPath, 'nanoclaw', 'sess-1');

    expect(handle.branchName).toBe(workerBranchName('sess-1'));
    expect(fs.existsSync(path.join(handle.worktreePath, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(handle.worktreePath, 'README.md'))).toBe(true);
    expect(git(repoPath, ['branch', '--list', handle.branchName])).toContain(handle.branchName);
  });

  it('gives two sessions two working copies', () => {
    const first = ensureWorktree(repoPath, 'nanoclaw', 'sess-1');
    const second = ensureWorktree(repoPath, 'nanoclaw', 'sess-2');

    expect(second.worktreePath).not.toBe(first.worktreePath);
    expect(second.branchName).not.toBe(first.branchName);
    expect(fs.existsSync(path.join(second.worktreePath, '.git'))).toBe(true);
  });

  // A respawned helper calls this again with the same session id. It wants the
  // working copy it already has, uncommitted work included.
  it('adopts the existing working copy on a second call', () => {
    const first = ensureWorktree(repoPath, 'nanoclaw', 'sess-1');
    fs.writeFileSync(path.join(first.worktreePath, 'in-progress.txt'), 'half-done\n');

    const again = ensureWorktree(repoPath, 'nanoclaw', 'sess-1');

    expect(again.worktreePath).toBe(first.worktreePath);
    expect(fs.readFileSync(path.join(again.worktreePath, 'in-progress.txt'), 'utf-8')).toBe('half-done\n');
  });

  // A pushed commit's author is permanent history in a repository nanoclaw does
  // not own, so it must never carry the operator's identity.
  it('commits as the worker, never as the operator', () => {
    const handle = ensureWorktree(repoPath, 'nanoclaw', 'sess-1');

    expect(git(handle.worktreePath, ['config', 'user.email'])).toBe('worker+nanoclaw@nanoclaw.invalid');
    expect(git(handle.worktreePath, ['config', 'user.name'])).toContain('nanoclaw worker');
  });

  // An unlocked worktree is one `git worktree prune` away from deletion, and
  // that command runs in the operator's own clone where nothing shows it lives.
  it('locks the working copy against a prune in the source clone', () => {
    const handle = ensureWorktree(repoPath, 'nanoclaw', 'sess-1');

    expect(git(repoPath, ['worktree', 'list', '--porcelain'])).toContain('locked');
    git(repoPath, ['worktree', 'prune']);
    expect(fs.existsSync(path.join(handle.worktreePath, '.git'))).toBe(true);
  });

  // E3: git names host paths in its own errors, and the agent reads this text.
  it('refuses a path that is not a repository without naming it', () => {
    const notARepo = path.join(tmp, 'not-a-repo');
    fs.mkdirSync(notARepo);

    let thrown: unknown;
    try {
      ensureWorktree(notARepo, 'nanoclaw', 'sess-1');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(WorktreeError);
    expect((thrown as Error).message).toContain('nanoclaw');
    expect((thrown as Error).message).not.toContain(notARepo);
    expect((thrown as Error).message).not.toContain(tmp);
  });
});
