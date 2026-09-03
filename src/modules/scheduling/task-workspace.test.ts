/**
 * The series id is what keeps one task on one branch.
 *
 * `findSystemSession` filters `status = 'active'`, so a spent one-shot's
 * session closes and the next run mints a session with a NEW id. Every
 * assertion here exists to catch a derivation that reaches for the session
 * instead: that would fork the branch on each fire and strand the previous
 * run's commits, silently.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { workspaceSeriesId } from './create.js';
import { prepareTaskWorkspace, taskBranch, taskWorkspace } from './task-workspace.js';

// Mutable so one test can assert the driver refusal without affecting the
// rest of this file, which all assume the default 'local' driver.
const driverKind = vi.hoisted(() => ({ value: 'local' }));
vi.mock('../../drivers/index.js', () => ({
  getSessionDriver: () => ({ kind: driverKind.value }),
}));

afterEach(() => {
  driverKind.value = 'local';
});

const REPO = '/tmp/nanoclaw-test-repo';

describe('taskBranch', () => {
  it('namespaces the branch under nanoclaw/ and names the series', () => {
    expect(taskBranch('pr-review-a25c')).toBe('nanoclaw/pr-review-a25c');
  });

  it('gives two series two branches', () => {
    expect(taskBranch('one')).not.toBe(taskBranch('two'));
  });
});

describe('taskWorkspace', () => {
  it('is a pure function of repo and series, so a re-derivation is stable', () => {
    expect(taskWorkspace(REPO, 'series-1')).toBe(taskWorkspace(REPO, 'series-1'));
  });

  it('separates two series in the same repository', () => {
    expect(taskWorkspace(REPO, 'series-1')).not.toBe(taskWorkspace(REPO, 'series-2'));
  });

  it('puts the worktree outside the repository it checks out', () => {
    // A worktree inside its own checkout loads the OUTER checkout's CLAUDE.md
    // on top of its own — the leak commit 5a592b62 fixed for group folders.
    expect(taskWorkspace(REPO, 'series-1').startsWith(`${REPO}/`)).toBe(false);
  });
});

describe('prepareTaskWorkspace', () => {
  it('reports an unresolvable repository instead of throwing', () => {
    // Callers answer a blocking tool. An unhandled throw there is a request
    // that dies with nobody told.
    const result = prepareTaskWorkspace('no-such-repo-here', 'series-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no-such-repo-here');
  });

  it('names the repository in the error, so the operator can see what failed', () => {
    const result = prepareTaskWorkspace('wego/absent', 'series-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Cannot prepare a workspace/);
  });

  // A worktree lives on the host under WORKTREES_DIR and nothing mounts it
  // into a container — and nothing cheaply can, since a worktree's `.git` is
  // a pointer file into the parent repository. Left unrefused, the spawn
  // gets a cwd that does not exist inside the container, dies at the first
  // query, and the undelivered brief respawns it in a loop with no readable
  // cause.
  it('refuses under any driver but local, before ever touching git', () => {
    driverKind.value = 'docker';

    const result = prepareTaskWorkspace(REPO, 'series-1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('local runtime driver');
      expect(result.error).toContain('docker');
    }
  });
});

describe('workspaceSeriesId', () => {
  it('is derived, so the same request twice finds the same workspace', () => {
    // The whole reason it cannot use `makeTaskId`: random hex would make a
    // repeated call mint a second series, a second branch, a second worktree.
    expect(workspaceSeriesId('saber', 'sess-1')).toBe(workspaceSeriesId('saber', 'sess-1'));
  });

  it('separates two conversations working in one repository', () => {
    expect(workspaceSeriesId('saber', 'sess-1')).not.toBe(workspaceSeriesId('saber', 'sess-2'));
  });

  it('separates two repositories in one conversation', () => {
    expect(workspaceSeriesId('saber', 'sess-1')).not.toBe(workspaceSeriesId('nanoclaw', 'sess-1'));
  });

  it('keeps the repository readable in front, so a stray worktree is identifiable', () => {
    expect(workspaceSeriesId('wego/saber', 'sess-1').startsWith('wego-saber-')).toBe(true);
  });

  it('gives a repo-less run its own lane rather than failing', () => {
    expect(workspaceSeriesId(null, 'sess-1').startsWith('home-')).toBe(true);
  });

  it('does not collide a repo-less lane with a repository named home', () => {
    expect(workspaceSeriesId(null, 'sess-1')).not.toBe(workspaceSeriesId('home', 'sess-1'));
  });

  it('stays safe as a thread suffix, filename and branch segment', () => {
    expect(workspaceSeriesId('wego/saber', 'sess-1')).toMatch(/^[a-z0-9-]+$/);
  });
});
