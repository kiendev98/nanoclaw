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

const { ensureWorktree, WorktreeError, workerBranchName, workerWorktreePath } = await import('./worktree.js');

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

/**
 * `git worktree add` writes each gitlink and leaves the directory empty, and
 * git calls its own submodule support in worktrees incomplete. Observed: a
 * worker handed an empty submodule read the operator's checkout instead.
 *
 * The submodule is named `shared-lib` and checked out at `vendor/lib` on
 * purpose. git stores it under the name, so a lookup keyed on the path misses
 * it and falls back to the network.
 */
describe('ensureWorktree with a submodule', () => {
  let modulePath: string;

  beforeEach(() => {
    modulePath = path.join(tmp, 'shared-lib');
    fs.mkdirSync(modulePath, { recursive: true });
    git(modulePath, ['init', '--quiet']);
    git(modulePath, ['config', 'user.name', 'Test Operator']);
    git(modulePath, ['config', 'user.email', 'operator@example.com']);
    fs.writeFileSync(path.join(modulePath, 'lib.txt'), 'shared\n');
    git(modulePath, ['add', 'lib.txt']);
    git(modulePath, ['commit', '--quiet', '-m', 'lib']);

    git(repoPath, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '--quiet',
      '--name',
      'shared-lib',
      modulePath,
      'vendor/lib',
    ]);
    git(repoPath, ['commit', '--quiet', '-m', 'add submodule']);
  });

  it('checks the submodule out into the working copy', () => {
    const handle = ensureWorktree(repoPath, 'nanoclaw', 'sess-1');

    expect(fs.readFileSync(path.join(handle.worktreePath, 'vendor/lib/lib.txt'), 'utf-8')).toBe('shared\n');
  });

  // The source clone already holds the objects. Cloning per worker costs a full
  // copy and a network round trip, on a thread this module caps at 30 seconds.
  it('takes the submodule from the source clone, never the remote', () => {
    fs.renameSync(modulePath, `${modulePath}-gone`);

    const handle = ensureWorktree(repoPath, 'nanoclaw', 'sess-1');

    expect(fs.readFileSync(path.join(handle.worktreePath, 'vendor/lib/lib.txt'), 'utf-8')).toBe('shared\n');
  });

  it('leaves the superproject tree clean', () => {
    const handle = ensureWorktree(repoPath, 'nanoclaw', 'sess-1');

    expect(git(handle.worktreePath, ['status', '--porcelain'])).toBe('');
  });

  // The worker commits its work inside the submodule, so that copy has to be a
  // writable checkout rather than a read-only export.
  it('gives the worker a submodule it can commit in', () => {
    const handle = ensureWorktree(repoPath, 'nanoclaw', 'sess-1');
    const submodule = path.join(handle.worktreePath, 'vendor/lib');
    fs.writeFileSync(path.join(submodule, 'lib.txt'), 'worker edit\n');

    git(submodule, ['-c', 'user.name=w', '-c', 'user.email=w@example.invalid', 'commit', '--quiet', '-am', 'edit']);

    expect(git(submodule, ['log', '--oneline', '-1'])).toContain('edit');
  });

  // A prune inside the submodule would take the worker's uncommitted work.
  it('locks the submodule copy against a prune', () => {
    const handle = ensureWorktree(repoPath, 'nanoclaw', 'sess-1');
    const moduleDir = path.join(repoPath, '.git', 'modules', 'shared-lib');

    expect(git(moduleDir, ['worktree', 'list', '--porcelain'])).toContain('locked');
    git(moduleDir, ['worktree', 'prune']);
    expect(fs.existsSync(path.join(handle.worktreePath, 'vendor/lib/lib.txt'))).toBe(true);
  });

  // A respawned helper must not lose what it wrote inside the submodule.
  it('adopts the populated submodule on a second call', () => {
    const first = ensureWorktree(repoPath, 'nanoclaw', 'sess-1');
    fs.writeFileSync(path.join(first.worktreePath, 'vendor/lib/in-progress.txt'), 'half-done\n');

    const again = ensureWorktree(repoPath, 'nanoclaw', 'sess-1');

    expect(fs.readFileSync(path.join(again.worktreePath, 'vendor/lib/in-progress.txt'), 'utf-8')).toBe('half-done\n');
  });

  // A stanza outlives the submodule it named. Both routes fail on it, and on
  // every retry, so refusing would strand every worker on this repository.
  it('leaves a stale .gitmodules stanza empty instead of refusing the task', () => {
    git(repoPath, ['rm', '--quiet', '-r', 'vendor/lib']);
    fs.writeFileSync(
      path.join(repoPath, '.gitmodules'),
      '[submodule "shared-lib"]\n\tpath = vendor/lib\n\turl = ./shared-lib\n',
    );
    git(repoPath, ['add', '.gitmodules']);
    git(repoPath, ['commit', '--quiet', '-m', 'remove the submodule, keep the stanza']);

    const handle = ensureWorktree(repoPath, 'nanoclaw', 'sess-1');

    expect(fs.existsSync(path.join(handle.worktreePath, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(handle.worktreePath, 'vendor/lib/lib.txt'))).toBe(false);
  });

  // `git config --get-regexp` exits 1 on no match, which threw a raw git error
  // carrying a host path — the one thing WorktreeError exists to prevent.
  it('treats a .gitmodules with no path key as no submodules', () => {
    fs.writeFileSync(path.join(repoPath, '.gitmodules'), '# nothing declared here\n');
    git(repoPath, ['add', '.gitmodules']);
    git(repoPath, ['commit', '--quiet', '-m', 'empty gitmodules']);

    const handle = ensureWorktree(repoPath, 'nanoclaw', 'sess-2');

    expect(fs.existsSync(path.join(handle.worktreePath, '.git'))).toBe(true);
  });

  // Both routes refuse a directory that already holds files, so an interrupted
  // attempt would otherwise fail on every retry.
  it('leaves a half-written submodule directory alone instead of refusing', () => {
    const worktreePath = workerWorktreePath('nanoclaw', 'sess-3');
    git(repoPath, ['worktree', 'add', '--quiet', '-b', workerBranchName('sess-3'), worktreePath]);
    fs.writeFileSync(path.join(worktreePath, 'vendor/lib/leftover.txt'), 'half\n');

    const handle = ensureWorktree(repoPath, 'nanoclaw', 'sess-3');

    expect(handle.worktreePath).toBe(worktreePath);
    expect(fs.readFileSync(path.join(worktreePath, 'vendor/lib/leftover.txt'), 'utf-8')).toBe('half\n');
  });

  // E3 again: the submodule refusal carries its own message, and the agent
  // reads it. A hollow submodule must fail loudly rather than reach the worker.
  it('refuses without naming a host path when neither route can supply it', () => {
    fs.rmSync(path.join(repoPath, '.git', 'modules', 'shared-lib'), { recursive: true, force: true });
    fs.renameSync(modulePath, `${modulePath}-gone`);

    let thrown: unknown;
    try {
      ensureWorktree(repoPath, 'nanoclaw', 'sess-1');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(WorktreeError);
    expect((thrown as Error).message).toContain('vendor/lib');
    expect((thrown as Error).message).toContain('nanoclaw');
    expect((thrown as Error).message).not.toContain(tmp);
  });
});
