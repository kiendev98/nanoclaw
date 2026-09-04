/**
 * Binding is the moment a lent conversation becomes real, and the worker is the
 * one party that does not know it yet. So these tests are about what the worker
 * is told, and about the order the telling comes in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { registerWorkerMigration } from '../db/migrate.js';
import type { OutboundMessage } from '../../../mailbox/index.js';
import type { Session } from '../../../types.js';
import type { WorkerChannelGrant } from '../types.js';

const { steps, delivered, warnings, deliveryFails } = vi.hoisted(() => ({
  steps: [] as string[],
  delivered: [] as Array<{ agentGroupId: string; sessionId: string; text: string; sender: string }>,
  warnings: [] as string[],
  deliveryFails: { value: false },
}));

vi.mock('../notify.js', () => ({
  deliverToSession: vi.fn((agentGroupId: string, sessionId: string, text: string, sender: string) => {
    steps.push('deliver');
    if (deliveryFails.value) return Promise.resolve(false);
    delivered.push({ agentGroupId, sessionId, text, sender });
    return Promise.resolve(true);
  }),
  replyToCaller: vi.fn((_session: Session, text: string) => {
    warnings.push(text);
    return Promise.resolve(true);
  }),
}));

vi.mock('../../../session-manager.js', () => ({
  writeSessionRouting: vi.fn(() => {
    steps.push('route');
    return Promise.resolve();
  }),
}));

const { createGrant, findLiveGrantForTask } = await import('../db/worker-channel-grants.js');
const { bindLentConversationThread } = await import('./bind-grant.js');

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

function aGrant(overrides: Partial<WorkerChannelGrant> = {}): WorkerChannelGrant {
  return {
    task_id: 'wt-1',
    helper_agent_group_id: 'ag-worker',
    helper_session_id: 'sess-worker',
    messaging_group_id: 'mg-lent',
    channel_type: 'slack',
    platform_id: 'slack:C123',
    root_message_id: 'wlend-1',
    thread_id: '',
    local_destination_name: 'conversation',
    granted_by_session_id: 'sess-principal',
    granted_at: NOW,
    released_at: null,
    ...overrides,
  };
}

function aRootPost(id = 'wlend-1'): OutboundMessage {
  return {
    id,
    kind: 'chat',
    platformId: 'slack:C123',
    channelType: 'slack',
    threadId: null,
    content: JSON.stringify({ text: 'Please review this PR.' }),
    inReplyTo: null,
  };
}

beforeEach(async () => {
  steps.length = 0;
  delivered.length = 0;
  warnings.length = 0;
  deliveryFails.value = false;
  registerWorkerMigration();
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

describe('bindLentConversationThread', () => {
  it('tells the worker it holds the conversation, naming the destination it was given', async () => {
    await createGrant(aGrant());

    await bindLentConversationThread(aRootPost(), PRINCIPAL, { firstDelivery: false, platformMsgId: '1788.42' });

    expect((await findLiveGrantForTask('wt-1'))?.thread_id).toBe('1788.42');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.agentGroupId).toBe('ag-worker');
    expect(delivered[0]!.sessionId).toBe('sess-worker');
    expect(delivered[0]!.sender).toBe('principal');
    expect(delivered[0]!.text).toContain('conversation');
  });

  // The worker spawned with no destinations, so its system prompt states it
  // cannot send and is never rebuilt. The message has to say the list changed.
  it('says the destination list changed since the session started', async () => {
    await createGrant(aGrant());

    await bindLentConversationThread(aRootPost(), PRINCIPAL, { firstDelivery: false, platformMsgId: '1788.42' });

    expect(delivered[0]!.text).toContain('changed since this session started');
    expect(delivered[0]!.text).toContain('send_message({ to: "conversation"');
  });

  // D3: the reach is one thread. A worker woken before its routing carries the
  // bound thread posts top-level, outside the conversation it was lent.
  it('wakes the worker only after the routing carries the bound thread', async () => {
    await createGrant(aGrant());

    await bindLentConversationThread(aRootPost(), PRINCIPAL, { firstDelivery: false, platformMsgId: '1788.42' });

    expect(steps).toEqual(['route', 'deliver']);
  });

  it('tells nobody when the message is an ordinary chat message', async () => {
    await bindLentConversationThread(aRootPost('m-1'), PRINCIPAL, { firstDelivery: false, platformMsgId: null });

    expect(delivered).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  // The hook fires for every delivered message, and a grant is bound once.
  it('tells nobody when the grant is already bound', async () => {
    await createGrant(aGrant({ thread_id: '1788.42' }));

    await bindLentConversationThread(aRootPost(), PRINCIPAL, { firstDelivery: false, platformMsgId: '1788.99' });

    expect(delivered).toHaveLength(0);
    expect(steps).toHaveLength(0);
  });

  // An unnamed thread is permanent: the grant keeps `thread_id = ''`, so even a
  // counterparty reply can never route to the worker.
  it('warns the principal when the platform never named the thread', async () => {
    await createGrant(aGrant());

    await bindLentConversationThread(aRootPost(), PRINCIPAL, { firstDelivery: false, platformMsgId: null });

    expect(delivered).toHaveLength(0);
    expect(warnings.at(-1)).toContain('never named the thread');
  });

  it('warns the principal when the worker session is gone', async () => {
    await createGrant(aGrant());
    deliveryFails.value = true;

    await bindLentConversationThread(aRootPost(), PRINCIPAL, { firstDelivery: false, platformMsgId: '1788.42' });

    expect(warnings.at(-1)).toContain('worker session is gone');
  });
});
