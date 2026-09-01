/**
 * `ncl worktrees` — the manual replacement for the reaper that was deliberately
 * deleted (282b8f6d).
 *
 * Every test here is about REFUSING to delete something. The proof that a
 * removal destroys nothing is `inspectWorktree`, tested against real git in
 * `src/worktree.test.ts`; these tests own the other half — that the command
 * asks for that proof, asks for it again immediately before deleting, keeps
 * everything it cannot prove, offers no way to override, and still tells the
 * shell the truth about what failed.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Literals, not the const below: vi.mock is hoisted over this file's
// initializers (the same note tasks.test.ts carries).
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-cli-worktrees',
    GROUPS_DIR: '/tmp/nanoclaw-test-cli-worktrees/groups',
    TIMEZONE: 'UTC',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-worktrees';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const { mockListWorktrees, mockInspectWorktree, mockRemoveWorktree } = vi.hoisted(() => ({
  mockListWorktrees: vi.fn(),
  mockInspectWorktree: vi.fn(),
  mockRemoveWorktree: vi.fn(),
}));

// The filesystem half is real-git-tested in src/worktree.test.ts. Faking it
// here is what keeps this file from ever removing a worktree the developer
// running the suite actually owns.
vi.mock('../../worktree.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../worktree.js')>()),
  listWorktrees: mockListWorktrees,
  inspectWorktree: mockInspectWorktree,
  removeWorktree: mockRemoveWorktree,
}));

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext, ResponseFrame } from '../frame.js';
import type { WorktreeEntry } from '../../worktree.js';
import './worktrees.js';
import '../commands/index.js'; // registers `help` and `worktrees-help`

const HOST: CallerContext = { caller: 'host' };
const AGENT: CallerContext = {
  caller: 'agent',
  agentGroupId: 'ag-worker',
  sessionId: 'sess-1',
  messagingGroupId: 'mg-1',
};

const CLEAN = '/tmp/wt/saber-nanoclaw-clean';
const DIRTY = '/tmp/wt/saber-nanoclaw-dirty';
const ORPHAN = '/tmp/wt/saber-nanoclaw-orphan';

function entry(path: string, clean: boolean, reason: string): WorktreeEntry {
  return { path, repo: 'saber', branch: 'nanoclaw/sess-1', state: { clean, reason } };
}

async function run(command: string, args: Record<string, unknown> = {}, ctx = HOST): Promise<ResponseFrame> {
  return dispatch({ id: `req-${command}`, command, args }, ctx);
}

/** The `human` view a client prints, or '' when the command failed. */
function human(res: ResponseFrame): string {
  return res.ok ? (res.human ?? '') : '';
}

describe('worktrees CLI resource', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = await initTestDb();
    await runMigrations(db);
    await createAgentGroup({
      id: 'ag-worker',
      name: 'Scout',
      folder: 'scout',
      agent_provider: null,
      created_at: new Date().toISOString(),
      workspace_path: CLEAN,
      origin_session_id: 'sess-1',
    });

    mockListWorktrees.mockReturnValue([
      entry(CLEAN, true, 'no uncommitted changes and no commits that exist nowhere else'),
      entry(DIRTY, false, '2 uncommitted change(s), 1 untracked file(s)'),
      entry(ORPHAN, true, 'no uncommitted changes and no commits that exist nowhere else'),
    ]);
    // Re-inspection agrees with the listing unless a test says otherwise.
    mockInspectWorktree.mockImplementation((path: string) =>
      path === DIRTY
        ? { clean: false, reason: '2 uncommitted change(s), 1 untracked file(s)' }
        : { clean: true, reason: 'no uncommitted changes and no commits that exist nowhere else' },
    );
    mockRemoveWorktree.mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await closeDb();
    vi.clearAllMocks();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  describe('list', () => {
    it('names the owning worker group, and says so when there is none', async () => {
      const res = await run('worktrees-list');
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const rows = res.data as { path: string; owner: string | null; owner_id: string | null }[];
      expect(rows.map((row) => row.path)).toEqual([CLEAN, DIRTY, ORPHAN]);
      expect(rows[0]).toMatchObject({ owner: 'Scout', owner_id: 'ag-worker' });
      // Orphaned, because `ncl groups delete` leaves the worktree behind.
      expect(rows[2]).toMatchObject({ owner: null, owner_id: null });
    });

    it('says WHY a dirty worktree is dirty, not merely that it is', async () => {
      const text = human(await run('worktrees-list'));
      expect(text).toContain('2 uncommitted change(s), 1 untracked file(s)');
      expect(text).toContain(`DIRTY  ${DIRTY}`);
      expect(text).toContain('repo: saber');
      expect(text).toContain('branch: nanoclaw/sess-1');
    });

    it('prints the git command for a dirty worktree instead of offering a flag', async () => {
      const text = human(await run('worktrees-list'));
      expect(text).toContain(`git -C ${DIRTY} worktree remove --force ${DIRTY}`);
      expect(text).toContain('would remove 2 and skip 1');
    });

    it('says nothing is there rather than printing an empty table', async () => {
      mockListWorktrees.mockReturnValue([]);
      expect(human(await run('worktrees-list'))).toContain('No worktrees under');
    });
  });

  describe('prune', () => {
    it('removes the clean worktrees and keeps the dirty one', async () => {
      const res = await run('worktrees-prune');
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(mockRemoveWorktree.mock.calls.map((call) => call[0])).toEqual([CLEAN, ORPHAN]);
      const result = res.data as { removed: string[]; skipped: { path: string; reason: string }[] };
      expect(result.removed).toEqual([CLEAN, ORPHAN]);
      expect(result.skipped).toEqual([
        {
          path: DIRTY,
          reason: '2 uncommitted change(s), 1 untracked file(s)',
          remove_it_yourself: `git -C ${DIRTY} worktree remove --force ${DIRTY}`,
        },
      ]);
    });

    it('holds an ORPHANED worktree to the same proof as an owned one', async () => {
      // Losing its agent group does not make its commits disposable.
      mockInspectWorktree.mockImplementation((path: string) =>
        path === ORPHAN
          ? { clean: false, reason: '3 commit(s) that exist nowhere else' }
          : { clean: true, reason: 'clean' },
      );

      const res = await run('worktrees-prune');
      expect(res.ok).toBe(true);
      expect(mockRemoveWorktree.mock.calls.map((call) => call[0])).not.toContain(ORPHAN);
      expect(human(res)).toContain('3 commit(s) that exist nowhere else');
    });

    it('re-inspects immediately before removing, so a worktree dirtied since the listing survives', async () => {
      // The listing is a snapshot; a worker can write a file between the two.
      mockInspectWorktree.mockImplementation((path: string) =>
        path === CLEAN ? { clean: false, reason: '1 untracked file(s)' } : { clean: true, reason: 'clean' },
      );

      const res = await run('worktrees-prune');
      expect(res.ok).toBe(true);
      expect(mockRemoveWorktree.mock.calls.map((call) => call[0])).toEqual([ORPHAN]);
    });

    it('exits zero when it skipped something — skipping is the normal outcome', async () => {
      const res = await run('worktrees-prune');
      expect(res.ok).toBe(true);
      expect(human(res)).toContain('Kept 1 worktree(s) that hold work');
    });

    it('exits non-zero when a removal actually FAILED, and still reports the run', async () => {
      mockRemoveWorktree.mockImplementation((path: string) => {
        if (path === ORPHAN) throw new Error(`git refused to remove ${path}: locked`);
      });

      const res = await run('worktrees-prune');
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.message).toContain('Failed to remove 1 worktree(s)');
      expect(res.error.message).toContain('locked');
      // The whole report travels with the failure: what went, and what stayed.
      expect(res.error.message).toContain(`Removed 1 clean worktree(s)`);
      expect(res.error.message).toContain(DIRTY);
    });

    it('has no --force, and rejects one rather than ignoring it', async () => {
      const res = await run('worktrees-prune', { force: true });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.message).toContain('unknown flag --force');
      expect(mockRemoveWorktree).not.toHaveBeenCalled();
    });

    it('never asks git to force, and never removes a directory itself', async () => {
      await run('worktrees-prune');
      // `removeWorktree` is the only removal path, and it takes a path and
      // nothing else — there is no argument that could carry --force.
      for (const call of mockRemoveWorktree.mock.calls) expect(call).toHaveLength(1);
    });
  });

  describe('remove', () => {
    it('removes one clean worktree named by --path', async () => {
      const res = await run('worktrees-remove', { path: CLEAN });
      expect(res.ok).toBe(true);
      expect(mockRemoveWorktree).toHaveBeenCalledExactlyOnceWith(CLEAN);
    });

    it('accepts the path as a positional target', async () => {
      const res = await run(`worktrees-remove-${CLEAN}`, {});
      expect(res.ok).toBe(true);
      expect(mockRemoveWorktree).toHaveBeenCalledExactlyOnceWith(CLEAN);
    });

    it('refuses a dirty worktree and hands over the git command instead', async () => {
      const res = await run('worktrees-remove', { path: DIRTY });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.message).toContain('2 uncommitted change(s)');
      expect(res.error.message).toContain(`git -C ${DIRTY} worktree remove --force ${DIRTY}`);
      expect(mockRemoveWorktree).not.toHaveBeenCalled();
    });

    it('refuses a path that is not a worktree it knows about', async () => {
      const res = await run('worktrees-remove', { path: '/etc' });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.message).toContain('no worktree at /etc');
      expect(mockRemoveWorktree).not.toHaveBeenCalled();
    });

    it('asks for a path rather than guessing one', async () => {
      const res = await run('worktrees-remove');
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.message).toContain('a worktree path is required');
    });
  });

  describe('operator boundary', () => {
    it.each(['worktrees-list', 'worktrees-prune', 'worktrees-remove'])(
      'refuses %s from inside a container, whatever its cli_scope',
      async (command) => {
        const res = await dispatch({ id: 'req-1', command, args: { path: CLEAN } }, AGENT);
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.error.code).toBe('forbidden');
        expect(res.error.message).toContain('operator-only');
        expect(mockRemoveWorktree).not.toHaveBeenCalled();
      },
    );
  });

  describe('discoverability', () => {
    it('is listed by `ncl help` with its verbs', async () => {
      const res = await run('help');
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const text = res.data as string;
      expect(text).toContain('worktrees');
      expect(text).toContain('verbs: list, prune, remove');
    });

    it('documents each verb under `ncl worktrees help <verb>`', async () => {
      const res = await run('worktrees-help', { id: 'prune' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const text = res.data as string;
      expect(text).toContain('ncl worktrees prune');
      expect(text).toContain('no --force');
    });
  });
});
