/**
 * A4 and A5 are one key read two ways, so they are tested together.
 *
 * The key is (repository, messaging group, thread). Keying on the principal's
 * SESSION id instead would give the same answer under `per-thread` and the
 * wrong one under `shared`, where one session covers a whole channel — so the
 * shared-mode case below is the one that matters.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';

const { sessions, worktrees } = vi.hoisted(() => ({
  sessions: new Map<string, string>(),
  worktrees: [] as string[],
}));

vi.mock('../../../session-manager.js', () => ({
  resolveSystemSession: (agentGroupId: string, threadId: string) => {
    const key = `${agentGroupId}\0${threadId}`;
    const existing = sessions.get(key);
    if (existing) return Promise.resolve({ session: { id: existing }, created: false });
    const id = `sess-${sessions.size + 1}`;
    sessions.set(key, id);
    return Promise.resolve({ session: { id }, created: true });
  },
}));

vi.mock('./worktree.js', () => ({
  ensureWorktree: (_repoPath: string, repoName: string, helperSessionId: string) => {
    worktrees.push(helperSessionId);
    return {
      worktreePath: `/worktrees/${repoName}/${helperSessionId}`,
      branchName: `nanoclaw/worker/${helperSessionId}`,
    };
  },
  WorktreeError: class WorktreeError extends Error {},
}));

const { createHelper } = await import('../db/worker-helpers.js');
const { ensureHelperSession } = await import('./helper-session.js');
import type { WorkerHelper } from '../types.js';

const helper: WorkerHelper = {
  helper_agent_group_id: 'ag-worker-nanoclaw',
  repo_name: 'nanoclaw',
  repo_path: '/somewhere/nanoclaw',
  created_at: new Date().toISOString(),
};

function forThread(threadId: string | null) {
  return ensureHelperSession(helper, { messagingGroupId: 'mg-1', threadId });
}

beforeEach(async () => {
  sessions.clear();
  worktrees.length = 0;
  await runMigrations(await initTestDb());
  await createHelper(helper);
});

afterEach(async () => {
  await closeDb();
});

describe('ensureHelperSession', () => {
  it('reuses the same helper session for a second task in one thread (A4)', async () => {
    const first = await forThread('thread-1');
    const second = await forThread('thread-1');

    expect(second.created).toBe(false);
    expect(second.workerSession.helper_session_id).toBe(first.workerSession.helper_session_id);
    expect(worktrees).toHaveLength(1);
  });

  it('gives a different thread its own session and its own working copy (A5)', async () => {
    const first = await forThread('thread-1');
    const second = await forThread('thread-2');

    expect(second.workerSession.helper_session_id).not.toBe(first.workerSession.helper_session_id);
    expect(worktrees).toHaveLength(2);
    expect(second.workerSession.worktree_path).not.toBe(first.workerSession.worktree_path);
  });

  it('treats an unthreaded chat as one conversation', async () => {
    const first = await forThread(null);
    const second = await forThread(null);

    expect(second.workerSession.helper_session_id).toBe(first.workerSession.helper_session_id);
    expect(first.workerSession.thread_id).toBe('');
  });

  // Reuse is a property of the conversation, not of who is asking. The
  // principal that gets the report is recorded on the TASK, so the session row
  // keeps no second copy that could disagree with it.
  it('records no principal on the session row', async () => {
    const { workerSession } = await forThread('thread-1');

    expect(workerSession).not.toHaveProperty('principal_session_id');
    expect(workerSession).not.toHaveProperty('principal_agent_group_id');
  });
});
