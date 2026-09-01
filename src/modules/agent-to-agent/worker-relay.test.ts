/**
 * A repo-scoped worker's reply must reach the human who asked for it, in the
 * thread they asked in, labelled as the worker's own words — and must reach
 * nothing else.
 *
 * Driven through `routeAgentMessage`, not through `relayWorkerReply` directly:
 * the guard decision, the destination ACL and the session lookup are all part of
 * what bounds the relay, and calling the relay in isolation would test the echo
 * while skipping every bound on it.
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { initSessionFolder } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { createDestination } from './db/agent-destinations.js';
import { routeAgentMessage } from './agent-route.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-worker-relay';
vi.mock('../../config.js', async () => ({
  ...(await vi.importActual<typeof import('../../config.js')>('../../config.js')),
  DATA_DIR: '/tmp/nanoclaw-test-worker-relay',
}));

const ORCHESTRATOR = 'ag-root';
const WORKER = 'ag-worker';
const OTHER = 'ag-other';
const MG = 'mg-slack';

function now(): string {
  return new Date().toISOString();
}

/** A real repository plus a real worktree, so the relay label names a real repo. */
function makeWorktree(root: string, repoName: string): string {
  const repoDir = path.join(root, repoName);
  fs.mkdirSync(repoDir, { recursive: true });
  const run = (args: string[]): void => void execFileSync('git', ['-C', repoDir, ...args], { stdio: 'ignore' });
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# demo\n');
  run(['add', '.']);
  run(['commit', '-m', 'init']);
  // Outside the repository, as the real placement is.
  const worktree = path.join(root, 'worktrees', `${repoName}-nanoclaw-sess-thread`);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  run(['worktree', 'add', worktree, '-b', 'nanoclaw/sess-thread']);
  return worktree;
}

function session(
  id: string,
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  createdAt = now(),
): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: createdAt,
  };
}

describe('worker reply relay', () => {
  let delivered: Array<{ channelType: string; platformId: string; threadId: string | null; content: string }>;
  let worktree: string;
  let humanSession: Session;
  let workerSession: Session;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    worktree = makeWorktree(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-repo-')), 'saber');

    const db = await initTestDb();
    await runMigrations(db);

    await createMessagingGroup({
      id: MG,
      channel_type: 'slack',
      platform_id: 'C123',
      name: 'eng',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await createAgentGroup({ id: ORCHESTRATOR, name: 'Root', folder: 'root', agent_provider: null, created_at: now() });
    await createAgentGroup({ id: OTHER, name: 'Other', folder: 'other', agent_provider: null, created_at: now() });

    humanSession = session('sess-thread', ORCHESTRATOR, MG, '1700000000.000100', '2026-01-01T00:00:00.000Z');
    await createSession(humanSession);

    // The worker exists FOR that session — this column is the whole bound.
    await createAgentGroup({
      id: WORKER,
      name: 'Scout',
      folder: 'scout',
      agent_provider: null,
      created_at: now(),
      workspace_path: worktree,
      origin_session_id: humanSession.id,
    });
    workerSession = session('sess-worker', WORKER, null, null);
    await createSession(workerSession);

    initSessionFolder(ORCHESTRATOR, humanSession.id);
    initSessionFolder(WORKER, workerSession.id);

    await createDestination({
      agent_group_id: WORKER,
      local_name: 'parent',
      target_type: 'agent',
      target_id: ORCHESTRATOR,
      created_at: now(),
    });

    delivered = [];
    setDeliveryAdapter({
      deliver: async (channelType, platformId, threadId, _kind, content) => {
        delivered.push({ channelType, platformId, threadId, content });
        return 'platform-msg-1';
      },
    });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  async function workerSays(text: string): Promise<void> {
    await routeAgentMessage(
      { id: 'out-1', platform_id: ORCHESTRATOR, content: JSON.stringify({ text }), in_reply_to: null },
      workerSession,
    );
  }

  it('delivers the worker text into the originating thread', async () => {
    await workerSays('Build is green on 3 commits.');

    expect(delivered).toHaveLength(1);
    expect(delivered[0].channelType).toBe('slack');
    expect(delivered[0].platformId).toBe('C123');
    // The thread comes from the ORIGIN SESSION's row, not from the message.
    expect(delivered[0].threadId).toBe('1700000000.000100');
    expect(JSON.parse(delivered[0].content).text).toContain('Build is green on 3 commits.');
  });

  it('labels the message with the worker and its repository', async () => {
    // Unlabelled, the text reads as the orchestrator's own conclusion, and the
    // human cannot tell which of several repositories answered.
    await workerSays('Done.');

    const text = JSON.parse(delivered[0].content).text as string;
    expect(text).toContain('Scout');
    expect(text).toContain('saber');
  });

  it('still hands the orchestrator its own copy', async () => {
    // The relay replaces the orchestrator's need to SPEAK for the worker, not
    // its need to know: it is orchestrating.
    await workerSays('Done.');

    const rows = readInbound(ORCHESTRATOR, humanSession.id);
    expect(rows.some((r) => r.content.includes('Done.'))).toBe(true);
  });

  it('does NOT relay when the target session is not the worker origin', async () => {
    // A second conversation with the same orchestrator. The worker holds a
    // destination row for the orchestrator, so the a2a send is authorized — but
    // this thread is not the one the worker was created for.
    // Newer than humanSession, so the a2a router's newest-active-session
    // fallback lands here — the worst case for the bound, not the easy one.
    const strangerSession = session('sess-stranger', ORCHESTRATOR, MG, '1700000000.000999', '2027-01-01T00:00:00.000Z');
    await createSession(strangerSession);
    initSessionFolder(ORCHESTRATOR, strangerSession.id);

    await routeAgentMessage(
      {
        id: 'out-2',
        platform_id: ORCHESTRATOR,
        content: JSON.stringify({ text: 'post me in the other thread' }),
        in_reply_to: null,
      },
      workerSession,
    );

    // The message really did land in the stranger session…
    expect(readInbound(ORCHESTRATOR, strangerSession.id).some((r) => r.content.includes('post me'))).toBe(true);
    // …and nothing was posted to any channel, because that thread is not the
    // one this worker was created for.
    expect(delivered).toHaveLength(0);
  });

  it('does not relay for an agent that is not a repo-scoped worker', async () => {
    // An ordinary sub-agent belongs to its creator, not to a conversation. Its
    // replies are the orchestrator's material, not the channel's.
    const plainSession = session('sess-other', OTHER, null, null);
    await createSession(plainSession);
    initSessionFolder(OTHER, plainSession.id);
    await createDestination({
      agent_group_id: OTHER,
      local_name: 'parent',
      target_type: 'agent',
      target_id: ORCHESTRATOR,
      created_at: now(),
    });

    await routeAgentMessage(
      { id: 'out-3', platform_id: ORCHESTRATOR, content: JSON.stringify({ text: 'hello' }), in_reply_to: null },
      plainSession,
    );

    expect(delivered).toHaveLength(0);
  });

  it('does not relay when the origin channel is detached', async () => {
    // The bot was removed from the conversation; posting would be rejected and
    // the orchestrator already holds the message.
    const { getDb } = await import('../../db/connection.js');
    await getDb().run('UPDATE messaging_groups SET detached_at = ? WHERE id = ?', now(), MG);

    await workerSays('Done.');

    expect(delivered).toHaveLength(0);
  });

  it('routes the message even when the channel delivery throws', async () => {
    // A relay failure must not fail the route: the inbound copy is already
    // written, so a throw would retry and duplicate it.
    setDeliveryAdapter({
      deliver: async () => {
        throw new Error('slack is down');
      },
    });

    await expect(workerSays('Done.')).resolves.toBeUndefined();
    const rows = readInbound(ORCHESTRATOR, humanSession.id);
    expect(rows.some((r) => r.content.includes('Done.'))).toBe(true);
  });
});

function readInbound(agentGroupId: string, sessionId: string): Array<{ content: string }> {
  const db = new Database(inboundDbPath(agentGroupId, sessionId), { readonly: true });
  const rows = db.prepare('SELECT content FROM messages_in ORDER BY seq').all() as Array<{ content: string }>;
  db.close();
  return rows;
}
