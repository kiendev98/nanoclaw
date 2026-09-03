/**
 * Tests for `answer_worker` — the door that carries intent.
 *
 * Every other way into a worker writes the same row. `send_message` and a
 * reused `spawn_worker` both end in `routeAgentMessage`, producing a
 * byte-identical `kind: 'chat'` envelope, so a worker blocked inside
 * `ask_user_question` had to GUESS which message was its answer: the first one
 * carrying text, after the question went out. Order was load-bearing, and an
 * orchestrator that sent a second instruction during the same turn had it
 * silently relabelled as the decision.
 *
 * Three properties carry the replacement, and each fails quietly if it breaks:
 *
 * - **An answer is a `question_response`, byte-identical to a button click.**
 *   That is what lets one wait serve both lanes, and what makes an ordinary
 *   message during the wait unambiguously not the answer.
 * - **It degrades rather than disappearing.** Past the tool's bound nothing is
 *   polling, and a system row with no waiter is skipped by kind and lost in
 *   silence — so an expired question becomes a plain message the worker can
 *   still act on, and the caller is told which outcome it got.
 * - **It grants nothing.** The ACL is `a2a.send`, the same decision an
 *   ordinary message makes. An orchestrator that cannot message a worker
 *   cannot answer one either.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingQuestion, Session } from '../../types.js';

const { mockSessionWrite, mockGetOpenQuestion, mockDeletePendingQuestion, mockHasDestination, mockGetMessagePolicy } =
  vi.hoisted(() => ({
    mockSessionWrite: vi.fn(),
    mockGetOpenQuestion: vi.fn().mockResolvedValue(undefined),
    mockDeletePendingQuestion: vi.fn(),
    mockHasDestination: vi.fn().mockResolvedValue(true),
    mockGetMessagePolicy: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock('../approvals/index.js', () => ({
  requestApproval: vi.fn().mockResolvedValue(undefined),
  notifyAgent: vi.fn(),
  registerApprovalHandler: vi.fn(),
}));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: vi.fn().mockResolvedValue({ cli_scope: 'group' }),
  ensureContainerConfig: () => {},
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => ({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: '' }),
  getAgentGroupByFolder: () => undefined,
  createAgentGroup: vi.fn(),
  updateAgentGroup: vi.fn(),
  findWorkerForOrigin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../group-init.js', () => ({ initGroupFilesystem: vi.fn() }));
vi.mock('./write-destinations.js', () => ({ writeDestinations: vi.fn() }));
vi.mock('./db/agent-destinations.js', () => ({
  getDestinationByName: () => undefined,
  getDestinationByTarget: vi.fn().mockResolvedValue(undefined),
  createDestination: vi.fn(),
  hasDestination: (...a: unknown[]) => mockHasDestination(...a),
  normalizeName: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));
vi.mock('./db/agent-message-policies.js', () => ({
  getMessagePolicy: (...a: unknown[]) => mockGetMessagePolicy(...a),
}));
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...a: unknown[]) => mockSessionWrite(...a),
  openInboundDb: vi.fn(),
  openOutboundDb: vi.fn(),
  clearOutbox: vi.fn(),
  readOutboxFiles: vi.fn().mockReturnValue([]),
  resolveSession: vi.fn(async (agentGroupId: string) => ({
    session: { id: `sess-of-${agentGroupId}`, agent_group_id: agentGroupId, status: 'active' },
    created: true,
  })),
  withExistingMailboxSession: vi.fn().mockResolvedValue(null),
  sessionDir: vi.fn().mockReturnValue('/tmp/nowhere'),
}));
vi.mock('../../container-runner.js', () => ({ wakeContainer: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../drivers/index.js', () => ({ getSessionDriver: () => ({ kind: 'local' }) }));
vi.mock('../../db/sessions.js', () => ({
  getSession: (id: string) => ({ id, agent_group_id: id.startsWith('sess-of-') ? id.slice(8) : 'ag-1' }),
  getPendingApproval: () => undefined,
  getRunningSessions: () => [],
  getActiveSessions: () => [],
  createPendingQuestion: vi.fn(),
  getOpenQuestionForAgentGroup: (...a: unknown[]) => mockGetOpenQuestion(...a),
  deletePendingQuestion: (...a: unknown[]) => mockDeletePendingQuestion(...a),
}));

// The barrel registers the guard catalog and the delivery action — the only
// reachable path to the body under test.
import './index.js';
import { getDeliveryAction } from '../../delivery.js';

const SESSION = { id: 'sess-1', agent_group_id: 'ag-orchestrator' } as Session;
const WORKER = 'ag-worker';

/** A request as the container tool writes it, still inside its wait window. */
function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'answer_worker',
    requestId: 'req-a1',
    waitUntil: Date.now() + 30_000,
    worker: WORKER,
    workerName: 'Scout',
    answer: 'Delete it',
    ...over,
  };
}

/** A recorded question, `ageMs` old. */
function question(ageMs = 0): PendingQuestion {
  return {
    question_id: 'msg-abc',
    session_id: 'sess-worker',
    message_out_id: 'msg-abc',
    platform_id: 'ag-orchestrator',
    channel_type: 'agent',
    thread_id: null,
    title: 'Legacy migration',
    options: [{ label: 'Delete it', selectedLabel: 'Delete it', value: 'Delete it' }],
    created_at: new Date(Date.now() - ageMs).toISOString(),
  } as PendingQuestion;
}

async function runAnswerWorker(content: Record<string, unknown>): Promise<void> {
  const wrapped = getDeliveryAction('answer_worker');
  expect(wrapped).toBeDefined();
  await wrapped!(content, SESSION);
}

/** Every `writeSessionMessage` call, as (agentGroupId, sessionId, message). */
function writes(): Array<[string, string, Record<string, unknown>]> {
  return mockSessionWrite.mock.calls as Array<[string, string, Record<string, unknown>]>;
}

/** The rows written into the worker, by content type. */
function rowsTo(sessionId: string): Array<Record<string, unknown>> {
  return writes()
    .filter(([, id]) => id === sessionId)
    .map(([, , msg]) => JSON.parse(msg.content as string) as Record<string, unknown>);
}

/** What the blocking tool is told. */
function toolResponse(): { status?: string; result?: { message?: string; error?: string } } | undefined {
  const row = writes()
    .map(([, , msg]) => JSON.parse(msg.content as string) as Record<string, unknown>)
    .find((c) => c.type === 'answer_worker_response');
  return row as { status?: string; result?: { message?: string; error?: string } } | undefined;
}

beforeEach(() => {
  mockSessionWrite.mockClear();
  mockDeletePendingQuestion.mockClear();
  mockGetOpenQuestion.mockResolvedValue(undefined);
  mockHasDestination.mockResolvedValue(true);
  mockGetMessagePolicy.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('answering a worker that is waiting', () => {
  it('writes a question_response the blocked tool recognises', async () => {
    // Byte-identical to what a button click produces on a channel — which is
    // what lets one wait serve both lanes.
    mockGetOpenQuestion.mockResolvedValue(question());

    await runAnswerWorker(request());

    const [response] = rowsTo('sess-worker').filter((c) => c.type === 'question_response');
    expect(response).toBeDefined();
    expect(response.questionId).toBe('msg-abc');
    expect(response.selectedOption).toBe('Delete it');
  });

  it('clears the pending row, so a second answer cannot re-use it', async () => {
    mockGetOpenQuestion.mockResolvedValue(question());

    await runAnswerWorker(request());

    expect(mockDeletePendingQuestion).toHaveBeenCalledWith('msg-abc');
  });

  it('tells the caller the worker was actually unblocked', async () => {
    // The distinction matters: the orchestrator reports to a human, and
    // "answered" and "delivered as a message" are different outcomes.
    mockGetOpenQuestion.mockResolvedValue(question());

    await runAnswerWorker(request());

    expect(toolResponse()?.status).toBe('answered');
  });

  it('does not deliver the answer twice', async () => {
    // The fast path replaces the message, it does not accompany it. A worker
    // that both resumed AND received "Delete it" as new work would act on it
    // a second time.
    mockGetOpenQuestion.mockResolvedValue(question());

    await runAnswerWorker(request());

    expect(rowsTo('sess-worker').filter((c) => c.type !== 'question_response')).toHaveLength(0);
  });
});

describe('degrading when nothing is waiting', () => {
  it('delivers as an ordinary message when no question is open', async () => {
    // Never as a question_response on spec: the poll loop skips system rows by
    // kind, so one written with no waiter is discarded in silence.
    await runAnswerWorker(request());

    const rows = rowsTo('sess-of-ag-worker');
    expect(rows.some((c) => c.text === 'Delete it')).toBe(true);
    expect(rows.some((c) => c.type === 'question_response')).toBe(false);
  });

  it('says so, rather than reporting the worker resumed', async () => {
    await runAnswerWorker(request());

    const response = toolResponse();
    expect(response?.status).toBe('delivered');
    expect(response?.result?.message).toContain('not waiting on a question');
  });

  it('degrades once the question has outlived the tool that asked it', async () => {
    // The host expires on the same 600s bound the tool waits, because past it
    // nobody is polling for a response.
    mockGetOpenQuestion.mockResolvedValue(question(600_001));

    await runAnswerWorker(request());

    expect(rowsTo('sess-of-ag-worker').some((c) => c.text === 'Delete it')).toBe(true);
    expect(toolResponse()?.result?.message).toContain('timed out');
  });

  it('drops the stale row, so it cannot capture a later answer', async () => {
    mockGetOpenQuestion.mockResolvedValue(question(600_001));

    await runAnswerWorker(request());

    expect(mockDeletePendingQuestion).toHaveBeenCalledWith('msg-abc');
  });
});

describe('it grants nothing a message would not', () => {
  it('refuses when the caller holds no destination for that worker', async () => {
    // The ACL is a2a.send, unchanged. Answering is not a narrower door into a
    // worker the orchestrator cannot otherwise reach.
    mockGetOpenQuestion.mockResolvedValue(question());
    mockHasDestination.mockResolvedValue(false);

    await runAnswerWorker(request());

    const response = toolResponse();
    expect(response?.status).toBe('error');
    expect(response?.result?.error).toContain('unauthorized');
  });

  it('leaves the question open when it refuses', async () => {
    // A refused answer must not consume the worker's one chance to be told.
    mockGetOpenQuestion.mockResolvedValue(question());
    mockHasDestination.mockResolvedValue(false);

    await runAnswerWorker(request());

    expect(mockDeletePendingQuestion).not.toHaveBeenCalled();
  });

  it('leaves an EXPIRED question alone when it refuses', async () => {
    // The ordering bug this pins. Authorization used to run after the lookup
    // and after the expiry delete, so an unauthorized caller — naming any
    // agent group it liked, since the payload is re-read from an untrusted
    // container — could destroy that group's pending question and only then
    // be turned away. The delete is unrecoverable: the asking tool waits out
    // its bound and the answer is gone.
    //
    // The test above passes on the broken order too, because a fresh row is
    // never deleted. Age is the whole point of this one.
    mockGetOpenQuestion.mockResolvedValue(question(600_001));
    mockHasDestination.mockResolvedValue(false);

    await runAnswerWorker(request());

    expect(mockDeletePendingQuestion).not.toHaveBeenCalled();
    expect(toolResponse()?.status).toBe('error');
  });

  it('does not even look the question up until the caller is authorized', async () => {
    // Stronger than the two above and the reason they hold: nothing about the
    // named group is read before the guard answers.
    mockHasDestination.mockResolvedValue(false);

    await runAnswerWorker(request());

    expect(mockGetOpenQuestion).not.toHaveBeenCalled();
  });

  it('routes through the message path when a policy holds this pair', async () => {
    // A hold is the admin's decision about these two agents talking, and an
    // answer is them talking. Taking the fast path would bypass the card.
    mockGetOpenQuestion.mockResolvedValue(question());
    mockGetMessagePolicy.mockResolvedValue({ approver: 'user:admin' });

    await runAnswerWorker(request());

    expect(rowsTo('sess-worker').some((c) => c.type === 'question_response')).toBe(false);
    expect(toolResponse()?.result?.message).toContain('held for admin approval');
  });
});

describe('malformed requests are answered, never held', () => {
  it('rejects a request with no worker', async () => {
    await runAnswerWorker(request({ worker: '' }));

    expect(toolResponse()?.result?.error).toContain('worker is required');
  });

  it('rejects a request with no answer', async () => {
    await runAnswerWorker(request({ answer: '' }));

    expect(toolResponse()?.result?.error).toContain('answer is required');
  });

  it('never reaches the worker when the request is malformed', async () => {
    await runAnswerWorker(request({ answer: '' }));

    expect(mockGetOpenQuestion).not.toHaveBeenCalled();
  });
});
