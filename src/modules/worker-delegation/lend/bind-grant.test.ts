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
import type { WorkerChannelGrant, WorkerQuestion } from '../types.js';

const { steps, delivered, warnings, deliveryFails, deliveryThrows, answerRace } = vi.hoisted(() => ({
  steps: [] as string[],
  delivered: [] as Array<{ agentGroupId: string; sessionId: string; text: string; sender: string }>,
  warnings: [] as string[],
  deliveryFails: { value: false },
  deliveryThrows: { value: false },
  answerRace: { value: false },
}));

// `answer_worker_question` can delete the row between the hook's read and its
// delete. This mock consumes it in exactly that window.
vi.mock('../db/worker-questions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/worker-questions.js')>();
  return {
    ...actual,
    findOpenQuestion: async (helperSessionId: string) => {
      const open = await actual.findOpenQuestion(helperSessionId);
      if (open && answerRace.value) await actual.consumeQuestion(open.question_id);
      return open;
    },
  };
});

vi.mock('../notify.js', () => ({
  deliverToSession: vi.fn((agentGroupId: string, sessionId: string, text: string, sender: string) => {
    steps.push('deliver');
    if (deliveryThrows.value) return Promise.reject(new Error('mailbox is unreachable'));
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
const { isLentThread } = await import('./lent-threads.js');
const { createQuestion, findOpenQuestion } = await import('../db/worker-questions.js');
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

function anOpenQuestion(overrides: Partial<WorkerQuestion> = {}): WorkerQuestion {
  return {
    question_id: 'wq-1',
    task_id: 'wt-1',
    helper_session_id: 'sess-worker',
    helper_agent_group_id: 'ag-worker',
    principal_agent_group_id: 'ag-principal',
    principal_session_id: 'sess-principal',
    question_text: 'May I have the review channel?',
    created_at: NOW,
    ...overrides,
  };
}

beforeEach(async () => {
  steps.length = 0;
  delivered.length = 0;
  warnings.length = 0;
  deliveryFails.value = false;
  deliveryThrows.value = false;
  answerRace.value = false;
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

    expect((await findLiveGrantForTask('wt-1'))?.thread_id).toBe('slack:C123:1788.42');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.agentGroupId).toBe('ag-worker');
    expect(delivered[0]!.sessionId).toBe('sess-worker');
    expect(delivered[0]!.sender).toBe('principal');
    expect(delivered[0]!.text).toContain('conversation');
  });

  // The platform names the thread with the raw id of the post that started it,
  // and its adapter addresses that thread as `<platform id>:<raw id>`. A grant
  // holding the raw id hands the adapter a thread id it refuses, so every
  // message the worker sends is dropped and no reply routes back.
  it('binds the grant to the thread id the adapter addresses, not the raw message id', async () => {
    await createGrant(aGrant());

    await bindLentConversationThread(aRootPost(), PRINCIPAL, { firstDelivery: false, platformMsgId: '1788.42' });

    const bound = await findLiveGrantForTask('wt-1');
    expect(bound?.thread_id).toBe('slack:C123:1788.42');
    expect(isLentThread('slack', 'slack:C123', 'slack:C123:1788.42')).toBe(true);
  });

  // A native adapter carries its own address format and its own thread shape,
  // neither of which this module knows. Composing one would invent an address.
  it('leaves the raw id alone for a platform address that carries no channel prefix', async () => {
    await createGrant(aGrant({ channel_type: 'signal', platform_id: '+15551234567' }));
    const rootPost = { ...aRootPost(), channelType: 'signal', platformId: '+15551234567' };

    await bindLentConversationThread(rootPost, PRINCIPAL, { firstDelivery: false, platformMsgId: '1788.42' });

    expect((await findLiveGrantForTask('wt-1'))?.thread_id).toBe('1788.42');
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

  // A worker asks for the conversation through ask_principal, and the principal
  // answers with the lend. C9 allows one open question, so a question left open
  // here refuses every later ask for the rest of the task.
  it('closes the open question the lend answered', async () => {
    await createGrant(aGrant());
    await createQuestion(anOpenQuestion());

    await bindLentConversationThread(aRootPost(), PRINCIPAL, { firstDelivery: false, platformMsgId: '1788.42' });

    expect(await findOpenQuestion('sess-worker')).toBeUndefined();
  });

  // A lend is not always an answer. A worker that was asking about something
  // else has to learn which question was spent.
  it('names the closed question in the notice', async () => {
    await createGrant(aGrant());
    await createQuestion(anOpenQuestion({ question_id: 'wq-7' }));

    await bindLentConversationThread(aRootPost(), PRINCIPAL, { firstDelivery: false, platformMsgId: '1788.42' });

    expect(delivered[0]!.text).toContain('closed your open question wq-7');
    expect(delivered[0]!.text).toContain('ask again');
  });

  it('says nothing about a question when the worker had none open', async () => {
    await createGrant(aGrant());

    await bindLentConversationThread(aRootPost(), PRINCIPAL, { firstDelivery: false, platformMsgId: '1788.42' });

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).not.toContain('question');
  });

  // The question is closed before the delivery on purpose. A worker whose
  // notice never lands is still free to ask again.
  it('closes the question even when the worker session is gone', async () => {
    await createGrant(aGrant());
    await createQuestion(anOpenQuestion());
    deliveryFails.value = true;

    await bindLentConversationThread(aRootPost(), PRINCIPAL, { firstDelivery: false, platformMsgId: '1788.42' });

    expect(await findOpenQuestion('sess-worker')).toBeUndefined();
  });

  // The hook fires once and delivery swallows what it throws, so nothing
  // retries. A throw is transient, and the principal is the only party left to
  // tell — with different words from the permanent case.
  it('tells the principal in transient words when the notice throws', async () => {
    await createGrant(aGrant());
    deliveryThrows.value = true;

    await bindLentConversationThread(aRootPost(), PRINCIPAL, { firstDelivery: false, platformMsgId: '1788.42' });

    expect(warnings.at(-1)).toContain('did not go through');
    expect(warnings.at(-1)).toContain('the conversation is live');
    expect(warnings.at(-1)).not.toContain('worker session is gone');
    expect((await findLiveGrantForTask('wt-1'))?.thread_id).toBe('slack:C123:1788.42');
  });

  // The question is closed before the notice, so a failed notice costs the
  // worker its one open ask and tells it nothing. The principal is the only
  // party left who can learn both halves of that.
  it('tells the principal the question closed when the notice throws', async () => {
    await createGrant(aGrant());
    await createQuestion(anOpenQuestion({ question_id: 'wq-7' }));
    deliveryThrows.value = true;

    await bindLentConversationThread(aRootPost(), PRINCIPAL, { firstDelivery: false, platformMsgId: '1788.42' });

    expect(warnings.at(-1)).toContain('did not go through');
    expect(warnings.at(-1)).toContain('closed its open question wq-7');
    expect(warnings.at(-1)).toContain('the worker was not told');
  });

  it('tells the principal the question closed when the worker session is gone', async () => {
    await createGrant(aGrant());
    await createQuestion(anOpenQuestion({ question_id: 'wq-7' }));
    deliveryFails.value = true;

    await bindLentConversationThread(aRootPost(), PRINCIPAL, { firstDelivery: false, platformMsgId: '1788.42' });

    expect(warnings.at(-1)).toContain('worker session is gone');
    expect(warnings.at(-1)).toContain('closed its open question wq-7');
  });

  it('says nothing about a question when the worker had none open and the notice throws', async () => {
    await createGrant(aGrant());
    deliveryThrows.value = true;

    await bindLentConversationThread(aRootPost(), PRINCIPAL, { firstDelivery: false, platformMsgId: '1788.42' });

    expect(warnings.at(-1)).not.toContain('question');
  });

  // Another answer can close the same question first. Naming it then credits
  // this lend with a close it never made.
  it('names no question when another answer closed it first', async () => {
    await createGrant(aGrant());
    await createQuestion(anOpenQuestion({ question_id: 'wq-7' }));
    answerRace.value = true;

    await bindLentConversationThread(aRootPost(), PRINCIPAL, { firstDelivery: false, platformMsgId: '1788.42' });

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).not.toContain('question');
  });
});
