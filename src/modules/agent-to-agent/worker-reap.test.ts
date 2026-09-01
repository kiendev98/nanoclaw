/**
 * Retiring a worker must never destroy work.
 *
 * The decision half is pure and tested directly. The acting half is tested
 * against real git worktrees, because "is this worktree clean" is a question
 * only git can answer and a mocked answer would test the mock.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup, createMessagingGroup, getAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { setDeliveryAdapter } from '../../delivery.js';
import type { Session } from '../../types.js';
import { createDestination } from './db/agent-destinations.js';
import { decideWorkerReap, reapFinishedWorkers, WORKER_IDLE_MS } from './worker-reap.js';

const mockIsContainerRunning = vi.hoisted(() => vi.fn().mockReturnValue(false));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: (...a: unknown[]) => mockIsContainerRunning(...a),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-worker-reap';
vi.mock('../../config.js', async () => ({
  ...(await vi.importActual<typeof import('../../config.js')>('../../config.js')),
  DATA_DIR: '/tmp/nanoclaw-test-worker-reap',
}));
vi.mock('./write-destinations.js', () => ({ writeDestinations: vi.fn().mockResolvedValue(undefined) }));

const NOW = 1_800_000_000_000;

describe('decideWorkerReap', () => {
  const idle = { now: NOW, workerBusy: false, workerLastActiveMs: NOW - WORKER_IDLE_MS - 1 };

  it('never interrupts a worker that is mid-turn, even for a closed thread', () => {
    // The human closed a conversation, not a build.
    expect(decideWorkerReap({ ...idle, workerBusy: true, origin: null }).reap).toBe(false);
  });

  it('never retires a worker that was active recently', () => {
    expect(decideWorkerReap({ ...idle, workerLastActiveMs: NOW - 60_000, origin: null }).reap).toBe(false);
  });

  it('retires a worker whose originating session no longer exists', () => {
    expect(decideWorkerReap({ ...idle, origin: null }).reap).toBe(true);
  });

  it('retires a worker whose originating session is closed', () => {
    expect(decideWorkerReap({ ...idle, origin: { status: 'closed', lastActiveMs: NOW } }).reap).toBe(true);
  });

  it('retires a worker whose conversation has been silent for a day', () => {
    const silent = { status: 'active' as const, lastActiveMs: NOW - WORKER_IDLE_MS - 1 };
    expect(decideWorkerReap({ ...idle, origin: silent }).reap).toBe(true);
  });

  it('keeps a worker whose conversation is still live', () => {
    const live = { status: 'active' as const, lastActiveMs: NOW - 60_000 };
    expect(decideWorkerReap({ ...idle, origin: live }).reap).toBe(false);
  });
});

const ORCHESTRATOR = 'ag-root';
const WORKER = 'ag-worker';
const MG = 'mg-slack';
const LONG_AGO = new Date(Date.now() - 10 * WORKER_IDLE_MS).toISOString();

function session(over: Partial<Session> & Pick<Session, 'id' | 'agent_group_id'>): Session {
  return {
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: LONG_AGO,
    created_at: LONG_AGO,
    ...over,
  };
}

describe('reapFinishedWorkers', () => {
  let repo: string;
  let worktree: string;
  let delivered: string[];

  /** A real repository and a real worker worktree on its own branch. */
  function makeRepo(): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-repo-'));
    repo = path.join(root, 'saber');
    fs.mkdirSync(repo, { recursive: true });
    const run = (args: string[]): void => void execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    run(['init', '-b', 'main']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    run(['add', '.']);
    run(['commit', '-m', 'init']);
    worktree = path.join(root, 'worktrees', 'saber-nanoclaw-sess-thread');
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    run(['worktree', 'add', worktree, '-b', 'nanoclaw/sess-thread']);
  }

  function commitInWorktree(file: string): void {
    const run = (args: string[]): void => void execFileSync('git', ['-C', worktree, ...args], { stdio: 'ignore' });
    fs.writeFileSync(path.join(worktree, file), 'work\n');
    run(['add', '.']);
    run(['commit', '-m', 'agent work']);
  }

  async function seed(originStatus: Session['status']): Promise<void> {
    await createMessagingGroup({
      id: MG,
      channel_type: 'slack',
      platform_id: 'C123',
      name: 'eng',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: LONG_AGO,
    });
    await createAgentGroup({
      id: ORCHESTRATOR,
      name: 'Root',
      folder: 'root',
      agent_provider: null,
      created_at: LONG_AGO,
    });
    await createAgentGroup({
      id: WORKER,
      name: 'Scout',
      folder: 'scout',
      agent_provider: null,
      created_at: LONG_AGO,
      workspace_path: worktree,
      origin_session_id: 'sess-thread',
    });
    await createSession(
      session({
        id: 'sess-thread',
        agent_group_id: ORCHESTRATOR,
        messaging_group_id: MG,
        thread_id: '1700.0001',
        status: originStatus,
      }),
    );
    await createSession(session({ id: 'sess-worker', agent_group_id: WORKER }));
    await createDestination({
      agent_group_id: ORCHESTRATOR,
      local_name: 'scout',
      target_type: 'agent',
      target_id: WORKER,
      created_at: LONG_AGO,
    });
  }

  beforeEach(async () => {
    mockIsContainerRunning.mockReturnValue(false);
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    makeRepo();
    const db = await initTestDb();
    await runMigrations(db);
    delivered = [];
    setDeliveryAdapter({
      deliver: async (_ct, _pid, _tid, _kind, content) => {
        delivered.push(content);
        return 'msg-1';
      },
    });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('removes a CLEAN worktree and retires the group', async () => {
    await seed('closed');

    expect(await reapFinishedWorkers()).toBe(1);
    expect(fs.existsSync(worktree)).toBe(false);
    expect(await getAgentGroup(WORKER)).toBeUndefined();
  });

  it('leaves the branch behind, so the same thread can rebuild the same worktree', async () => {
    // This is what makes reaping cheap: the branch is named after the ORIGIN
    // session, and `git worktree remove` does not delete branches.
    await seed('closed');

    await reapFinishedWorkers();

    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'nanoclaw/sess-thread'], {
      encoding: 'utf-8',
    });
    expect(branches).toContain('nanoclaw/sess-thread');
  });

  it('does NOT remove a worktree with uncommitted or untracked files', async () => {
    fs.writeFileSync(path.join(worktree, 'notes.md'), 'half-finished analysis\n');
    await seed('closed');

    expect(await reapFinishedWorkers()).toBe(1);
    // The whole safety rule: the directory and its contents survive.
    expect(fs.existsSync(worktree)).toBe(true);
    expect(fs.readFileSync(path.join(worktree, 'notes.md'), 'utf-8')).toContain('half-finished');
  });

  it('does NOT remove a worktree holding commits that exist nowhere else', async () => {
    // Committed, so `status --porcelain` is empty — but the commit lives on no
    // other branch, remote or tag, and deleting the worktree would strand it.
    commitInWorktree('feature.ts');
    await seed('closed');

    await reapFinishedWorkers();

    expect(fs.existsSync(worktree)).toBe(true);
    expect(fs.existsSync(path.join(worktree, 'feature.ts'))).toBe(true);
  });

  it('posts the retained path into the originating thread', async () => {
    // A directory nobody can name is as good as deleted.
    fs.writeFileSync(path.join(worktree, 'notes.md'), 'half-finished\n');
    await seed('closed');

    await reapFinishedWorkers();

    expect(delivered).toHaveLength(1);
    const text = JSON.parse(delivered[0]).text as string;
    expect(text).toContain(worktree);
    expect(text).toContain('Scout');
  });

  it('retires the group even when the worktree is retained', async () => {
    // The conversation is over, so the worker is unreachable either way, and a
    // row nothing can address is exactly the accumulation this reaper exists to
    // stop.
    fs.writeFileSync(path.join(worktree, 'notes.md'), 'half-finished\n');
    await seed('closed');

    await reapFinishedWorkers();

    expect(await getAgentGroup(WORKER)).toBeUndefined();
  });

  it('leaves a worker alone while its conversation is live', async () => {
    await seed('active');
    const { getDb } = await import('../../db/connection.js');
    await getDb().run('UPDATE sessions SET last_active = ? WHERE id = ?', new Date().toISOString(), 'sess-thread');

    expect(await reapFinishedWorkers()).toBe(0);
    expect(await getAgentGroup(WORKER)).toBeDefined();
    expect(fs.existsSync(worktree)).toBe(true);
  });

  it('leaves a worker alone while its container is running', async () => {
    await seed('closed');
    mockIsContainerRunning.mockReturnValue(true);

    expect(await reapFinishedWorkers()).toBe(0);
    expect(fs.existsSync(worktree)).toBe(true);
  });

  it('never touches an ordinary agent group', async () => {
    // `origin_session_id` is NULL for every group that is not a repo worker,
    // which is every group that predates this feature.
    await seed('closed');

    await reapFinishedWorkers();

    expect(await getAgentGroup(ORCHESTRATOR)).toBeDefined();
  });
});
