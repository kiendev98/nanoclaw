/**
 * Lending is the most privileged thing a principal can do to a worker: it hands
 * over a real channel. So the tests are about what it refuses, and about the
 * shape of what it grants — one thread, bounded by one task.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createDestination, getDestinations } from '../agent-to-agent/db/agent-destinations.js';
import type { Session } from '../../types.js';

const { refusals, outbound, routed } = vi.hoisted(() => ({
  refusals: [] as string[],
  outbound: [] as Array<{ id: string; threadId: string | null; content: string }>,
  routed: [] as Array<{ group: string; session: string }>,
}));

vi.mock('./notify.js', () => ({
  deliverToSession: vi.fn().mockResolvedValue(undefined),
  replyToCaller: (_session: Session, text: string) => {
    refusals.push(text);
    return Promise.resolve();
  },
}));

vi.mock('../../session-manager.js', () => ({
  writeOutboundDirect: (
    _group: string,
    _session: string,
    msg: { id: string; threadId: string | null; content: string },
  ) => {
    outbound.push(msg);
    return Promise.resolve();
  },
  writeSessionRouting: (group: string, session: string) => {
    routed.push({ group, session });
    return Promise.resolve();
  },
}));

vi.mock('../agent-to-agent/write-destinations.js', () => ({
  writeDestinations: vi.fn().mockResolvedValue(undefined),
}));

const { createHelper } = await import('./db/worker-helpers.js');
const { createWorkerSession } = await import('./db/worker-sessions.js');
const { createTask } = await import('./db/worker-tasks.js');
const { findLiveGrantForTask } = await import('./db/worker-channel-grants.js');
const { lendConversation } = await import('./lend-conversation.js');
import type { WorkerSession, WorkerTask } from './types.js';

const NOW = new Date().toISOString();
const PRINCIPAL: Session = {
  id: 'sess-principal',
  agent_group_id: 'ag-principal',
  messaging_group_id: 'mg-origin',
  thread_id: 'thread-1',
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: NOW,
};

const workerSession: WorkerSession = {
  helper_session_id: 'sess-worker',
  helper_agent_group_id: 'ag-worker',
  repo_name: 'nanoclaw',
  messaging_group_id: 'mg-origin',
  thread_id: 'thread-1',
  worktree_path: '/worktrees/nanoclaw/sess-worker',
  branch_name: 'nanoclaw/worker/sess-worker',
  created_at: NOW,
};

function aTask(): WorkerTask {
  return {
    task_id: 'wt-1',
    helper_session_id: 'sess-worker',
    helper_agent_group_id: 'ag-worker',
    repo_name: 'nanoclaw',
    principal_agent_group_id: 'ag-principal',
    principal_session_id: 'sess-principal',
    description: 'run the review loop',
    status: 'running',
    draft_answer: null,
    progress_note_count: 0,
    last_progress_note_at: null,
    created_at: NOW,
    completed_at: null,
  };
}

const request = { repository: 'nanoclaw', destination: 'anya', text: 'Please review this PR.' };

beforeEach(async () => {
  refusals.length = 0;
  outbound.length = 0;
  routed.length = 0;
  await runMigrations(await initTestDb());

  for (const id of ['ag-principal', 'ag-worker']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: NOW });
  }
  await createMessagingGroup({
    id: 'mg-lent',
    channel_type: 'slack',
    platform_id: 'slack:C123',
    instance: 'slack',
    name: 'ai-anya',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: NOW,
  });
  await createDestination({
    agent_group_id: 'ag-principal',
    local_name: 'anya',
    target_type: 'channel',
    target_id: 'mg-lent',
    created_at: NOW,
  });
  await createHelper({
    helper_agent_group_id: 'ag-worker',
    repo_name: 'nanoclaw',
    repo_path: '/somewhere/nanoclaw',
    created_at: NOW,
  });
  await createWorkerSession(workerSession);
});

afterEach(async () => {
  await closeDb();
});

describe('lendConversation', () => {
  it('grants one destination and one task-scoped grant, and posts a top-level root', async () => {
    await createTask(aTask());
    await lendConversation(request, PRINCIPAL);

    const granted = await getDestinations('ag-worker');
    expect(granted).toHaveLength(1);
    expect(granted[0]!.target_id).toBe('mg-lent');

    const grant = await findLiveGrantForTask('wt-1');
    expect(grant?.helper_session_id).toBe('sess-worker');
    expect(grant?.local_destination_name).toBe(granted[0]!.local_name);
    // E4: a fresh top-level post, never a silent join of someone's thread.
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.threadId).toBeNull();
    expect(outbound[0]!.id).toBe(grant?.root_message_id);
  });

  // Routing is otherwise projected once, at container spawn. A worker lent a
  // conversation mid-task is already running, so without a refresh here it
  // keeps its pre-grant routing and every reply opens a new post (D6).
  it('refreshes the worker session routing so later replies stay in the thread', async () => {
    await createTask(aTask());
    await lendConversation(request, PRINCIPAL);

    expect(routed).toContainEqual({ group: 'ag-worker', session: 'sess-worker' });
  });

  it('refreshes no routing when the lend is refused', async () => {
    await lendConversation(request, PRINCIPAL);

    expect(routed).toHaveLength(0);
  });

  // The grant is bound to the thread the root post starts, and the platform
  // only names that thread once the post lands.
  it('leaves the grant unbound until its root post is delivered', async () => {
    await createTask(aTask());
    await lendConversation(request, PRINCIPAL);

    expect((await findLiveGrantForTask('wt-1'))?.thread_id).toBe('');
  });

  it('refuses when no worker is running for this conversation', async () => {
    await lendConversation({ ...request, repository: 'saber' }, PRINCIPAL);

    expect(refusals.at(-1)).toContain('no saber worker is running');
    expect(outbound).toHaveLength(0);
  });

  // The grant ends with the task, so a worker with no task has nothing to bound
  // it — lending one would be lending it indefinitely.
  it('refuses a worker with no running task', async () => {
    await lendConversation(request, PRINCIPAL);

    expect(refusals.at(-1)).toContain('no running task');
    expect(await getDestinations('ag-worker')).toHaveLength(0);
  });

  // D3: the reach is ONE conversation. A second grant would be a second.
  it('refuses a worker that already holds a conversation', async () => {
    await createTask(aTask());
    await lendConversation(request, PRINCIPAL);
    outbound.length = 0;

    await lendConversation(request, PRINCIPAL);
    expect(refusals.at(-1)).toContain('already holds a conversation');
    expect(outbound).toHaveLength(0);
  });

  it('writes nothing when the caller names a destination it does not hold', async () => {
    await createTask(aTask());
    await lendConversation({ ...request, destination: 'someone-elses' }, PRINCIPAL);

    expect(await getDestinations('ag-worker')).toHaveLength(0);
    expect(outbound).toHaveLength(0);
  });
});
