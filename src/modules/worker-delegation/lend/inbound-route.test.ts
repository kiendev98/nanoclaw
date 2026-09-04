/**
 * A thread a worker holds belongs to that worker.
 *
 * This is the one place the ordinary fan-out is bypassed, so the tests are
 * about what that bypass admits (D5: no name needed) and what it must still
 * ask (D10: exactly whoever the principal admits).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { registerWorkerMigration } from '../db/migrate.js';

const { written, wakes } = vi.hoisted(() => ({
  written: [] as Array<{ agentGroupId: string; sessionId: string; threadId: string | null; content: string }>,
  wakes: [] as string[],
}));

vi.mock('../../../session-manager.js', () => ({
  writeSessionMessage: (agentGroupId: string, sessionId: string, msg: { threadId: string | null; content: string }) => {
    written.push({ agentGroupId, sessionId, threadId: msg.threadId, content: msg.content });
    return Promise.resolve();
  },
}));

vi.mock('../../../db/sessions.js', () => ({
  getSession: (id: string) => Promise.resolve({ id, agent_group_id: 'ag-worker' }),
}));

vi.mock('../../../request-wake.js', () => ({
  requestWake: (session: { id: string }) => {
    wakes.push(session.id);
    return Promise.resolve(true);
  },
}));

const { createGrant } = await import('../db/worker-channel-grants.js');
const { createTask } = await import('../db/worker-tasks.js');
const { deliverToLentConversation } = await import('./inbound-route.js');
import type { WorkerChannelGrant, WorkerTask } from '../types.js';

const NOW = new Date().toISOString();

const task: WorkerTask = {
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

const grant: WorkerChannelGrant = {
  task_id: 'wt-1',
  helper_agent_group_id: 'ag-worker',
  helper_session_id: 'sess-worker',
  messaging_group_id: 'mg-lent',
  channel_type: 'slack',
  platform_id: 'slack:C123',
  root_message_id: 'wlend-1',
  thread_id: 'thread-99',
  local_destination_name: 'conversation',
  granted_by_session_id: 'sess-principal',
  granted_at: NOW,
  released_at: null,
};

function aMessage(threadId: string | null) {
  return {
    messagingGroupId: 'mg-lent',
    threadId,
    channelType: 'slack',
    platformId: 'slack:C123',
    message: { id: 'm-1', kind: 'chat' as const, timestamp: NOW, content: '{"text":"rework this"}' },
  };
}

const allowAll = () => Promise.resolve(true);

beforeEach(async () => {
  written.length = 0;
  wakes.length = 0;
  registerWorkerMigration();
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

describe('deliverToLentConversation', () => {
  // D5: the counterparty opened nothing and names nobody — a reply in the
  // thread is always meant for the worker that opened it.
  it('routes a reply in a held thread to the worker, unaddressed', async () => {
    await createTask(task);
    await createGrant(grant);

    expect(await deliverToLentConversation(aMessage('thread-99'), allowAll)).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]!.sessionId).toBe('sess-worker');
    expect(written[0]!.threadId).toBe('thread-99');
    expect(wakes).toEqual(['sess-worker']);
  });

  it('leaves every other thread to the ordinary fan-out', async () => {
    await createTask(task);
    await createGrant(grant);

    expect(await deliverToLentConversation(aMessage('thread-other'), allowAll)).toBe(false);
    expect(await deliverToLentConversation(aMessage(null), allowAll)).toBe(false);
    expect(written).toHaveLength(0);
  });

  it('leaves a released thread to the ordinary fan-out', async () => {
    const { releaseGrant } = await import('../db/worker-channel-grants.js');
    await createTask(task);
    await createGrant(grant);
    await releaseGrant('wt-1', NOW);

    expect(await deliverToLentConversation(aMessage('thread-99'), allowAll)).toBe(false);
    expect(written).toHaveLength(0);
  });

  // D10: a worker admits exactly who its principal admits, and the caller's own
  // gate is what decides — resolved against the PRINCIPAL on the task row.
  it('asks the caller about the principal, and drops a refused message', async () => {
    await createTask(task);
    await createGrant(grant);
    const asked: string[] = [];

    const held = await deliverToLentConversation(aMessage('thread-99'), (principal) => {
      asked.push(principal);
      return Promise.resolve(false);
    });

    expect(asked).toEqual(['ag-principal']);
    // Held, not handed back: a refused sender must not fall through to the
    // fan-out and reach some other agent instead.
    expect(held).toBe(true);
    expect(written).toHaveLength(0);
  });

  it('falls back to the ordinary fan-out when the grant has no task', async () => {
    await createGrant(grant);

    expect(await deliverToLentConversation(aMessage('thread-99'), allowAll)).toBe(false);
  });

  // The worker's system prompt was built at spawn, when it held no
  // destinations, and it is never rebuilt. Bare text would arrive against a
  // standing instruction that it cannot send at all.
  it('says which conversation the message came from, and how to answer it', async () => {
    await createTask(task);
    await createGrant(grant);

    await deliverToLentConversation(aMessage('thread-99'), allowAll);

    const content = JSON.parse(written[0]!.content) as { text: string };
    expect(content.text).toContain('conversation');
    expect(content.text).toContain('send_message');
    expect(content.text).toContain('ask_principal');
    expect(content.text).toContain('rework this');
  });

  it('keeps every other field the channel sent', async () => {
    await createTask(task);
    await createGrant(grant);
    const message = aMessage('thread-99');
    message.message.content = '{"text":"rework this","senderId":"U9","footer":"ctx"}';

    await deliverToLentConversation(message, allowAll);

    const content = JSON.parse(written[0]!.content) as Record<string, unknown>;
    expect(content.senderId).toBe('U9');
    expect(content.footer).toBe('ctx');
  });

  // A wrapper is worth less than the message it would replace.
  it('passes content through untouched when it carries no text', async () => {
    await createTask(task);
    await createGrant(grant);
    const message = aMessage('thread-99');
    message.message.content = 'not json at all';

    await deliverToLentConversation(message, allowAll);

    expect(written[0]!.content).toBe('not json at all');
  });
});
