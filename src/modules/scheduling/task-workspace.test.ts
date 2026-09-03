/**
 * The series id is what keeps one task on one branch.
 *
 * `findSystemSession` filters `status = 'active'`, so a spent one-shot's
 * session closes and the next run mints a session with a NEW id. Every
 * assertion here exists to catch a derivation that reaches for the session
 * instead: that would fork the branch on each fire and strand the previous
 * run's commits, silently.
 */
import { describe, expect, it } from 'vitest';

import { prepareTaskWorkspace, taskBranch, taskWorkspace } from './task-workspace.js';

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
});
