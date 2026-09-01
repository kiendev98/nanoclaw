/**
 * Tests for `create_worker` — the one call that creates or reuses a repo
 * worker AND briefs it.
 *
 * Three properties carry the feature, and each fails silently if it breaks:
 *
 * - **One call does everything.** Creation and the brief happen in the same
 *   request. The old shape woke the caller merely to say the worker existed,
 *   and the brief went out a turn later.
 * - **It never blocks on a human.** The container tool waits one minute; an
 *   approval can sit for hours. A held request is answered IMMEDIATELY with
 *   `pending`, and every late answer also WAKES the caller, because a response
 *   row nobody is polling any more is silence.
 * - **`repo` is a name, never a path.** cwd is the only thing that decides
 *   which repository's CLAUDE.md, skills and settings a worker loads, and it
 *   arrives from the untrusted container. An unresolvable name aborts; there
 *   is no fallback to the group folder, because a worker in the wrong
 *   directory looks exactly like one in the right directory.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingApproval, Session } from '../../types.js';

const WORKER_TEST_ROOT = '/tmp/nanoclaw-test-a2a-create-worker';
const WORKER_REPOS_ROOT = '/tmp/nanoclaw-test-a2a-create-worker/repos';
// PROJECT_ROOTS is the allowlist a `repo` argument is resolved against, and it
// is EMPTY in a real install unless the operator sets NANOCLAW_PROJECT_ROOTS.
// Literals, not the consts above: vi.mock is hoisted over them.
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-test-a2a-create-worker/groups',
  PROJECT_ROOTS: ['/tmp/nanoclaw-test-a2a-create-worker/repos'],
}));

const {
  mockRequestApproval,
  mockGetContainerConfig,
  mockCreateAgentGroup,
  mockInitGroupFilesystem,
  mockWriteDestinations,
  mockSessionWrite,
  mockFindWorkerForOrigin,
  mockGetDestinationByTarget,
  mockGetMessagePolicy,
  mockHasDestination,
  liveApprovals,
  approvalHandlers,
} = vi.hoisted(() => ({
  mockRequestApproval: vi.fn().mockResolvedValue(undefined),
  mockGetContainerConfig: vi.fn(),
  mockCreateAgentGroup: vi.fn(),
  mockInitGroupFilesystem: vi.fn(),
  mockWriteDestinations: vi.fn(),
  mockSessionWrite: vi.fn(),
  mockFindWorkerForOrigin: vi.fn().mockResolvedValue(undefined),
  mockGetDestinationByTarget: vi.fn().mockResolvedValue(undefined),
  mockGetMessagePolicy: vi.fn().mockResolvedValue(undefined),
  mockHasDestination: vi.fn().mockResolvedValue(true),
  liveApprovals: new Map<string, import('../../types.js').PendingApproval>(),
  approvalHandlers: new Map<string, (ctx: Record<string, unknown>) => Promise<void>>(),
}));

vi.mock('../approvals/index.js', () => ({
  requestApproval: (...a: unknown[]) => mockRequestApproval(...a),
  notifyAgent: vi.fn(),
  registerApprovalHandler: (action: string, handler: (ctx: Record<string, unknown>) => Promise<void>) => {
    approvalHandlers.set(action, handler);
  },
}));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: (...a: unknown[]) => mockGetContainerConfig(...a),
  ensureContainerConfig: () => {},
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => ({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: '' }),
  getAgentGroupByFolder: () => undefined,
  createAgentGroup: (...a: unknown[]) => mockCreateAgentGroup(...a),
  findWorkerForOrigin: (...a: unknown[]) => mockFindWorkerForOrigin(...a),
}));
vi.mock('../../group-init.js', () => ({
  initGroupFilesystem: (...a: unknown[]) => mockInitGroupFilesystem(...a),
}));
vi.mock('./write-destinations.js', () => ({
  writeDestinations: (...a: unknown[]) => mockWriteDestinations(...a),
}));
vi.mock('./db/agent-destinations.js', () => ({
  getDestinationByName: () => undefined,
  getDestinationByTarget: (...a: unknown[]) => mockGetDestinationByTarget(...a),
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
  // The worker has no prior a2a history, so the a2a router falls through to
  // this — the same `agent-shared` resolution a real worker's session gets.
  resolveSession: vi.fn(async (agentGroupId: string) => ({
    session: { id: `sess-of-${agentGroupId}`, agent_group_id: agentGroupId, status: 'active' },
    created: true,
  })),
  withExistingMailboxSession: vi.fn().mockResolvedValue(null),
  sessionDir: vi.fn().mockReturnValue('/tmp/nowhere'),
}));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../db/sessions.js', () => ({
  getSession: (id: string) => ({ id, agent_group_id: id.startsWith('sess-of-') ? id.slice(8) : 'ag-1' }),
  getPendingApproval: (id: string) => liveApprovals.get(id),
  getRunningSessions: () => [],
  getActiveSessions: () => [],
  createPendingQuestion: vi.fn(),
}));

// The a2a module barrel registers the guard catalog and both guard-wrapped
// delivery actions — the only reachable path to the body under test.
import './index.js';
import { getDeliveryAction } from '../../delivery.js';

const SESSION = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;
const REPO = 'demo-repo';
const WORKTREE = path.join(
  process.env.HOME || '',
  '.config',
  'nanoclaw',
  'worktrees',
  `${REPO}-nanoclaw-${SESSION.id}`,
);

/** A request as the container tool writes it — still inside its wait window. */
function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'create_worker',
    requestId: 'req-w1',
    waitUntil: Date.now() + 60_000,
    repo: REPO,
    task: 'Audit the gates and report what fails.',
    name: 'Scout',
    ...over,
  };
}

async function runCreateWorker(content: Record<string, unknown>): Promise<void> {
  const wrapped = getDeliveryAction('create_worker');
  expect(wrapped).toBeDefined();
  await wrapped!(content, SESSION);
}

/** Every `writeSessionMessage` call, as (agentGroupId, sessionId, message). */
function writes(): Array<[string, string, Record<string, unknown>]> {
  return mockSessionWrite.mock.calls as Array<[string, string, Record<string, unknown>]>;
}

/** The `create_worker` response row the blocking container tool polls for. */
function response(): { status: string; result: Record<string, string> } | undefined {
  for (const [, , message] of writes()) {
    if (message.kind !== 'system') continue;
    const parsed = JSON.parse(message.content as string) as {
      type?: string;
      status: string;
      result: Record<string, string>;
    };
    if (parsed.type === 'create_worker_response') return parsed;
  }
  return undefined;
}

/** Chat rows written into some OTHER agent group — the brief, on its way out. */
function briefsTo(agentGroupId: string): string[] {
  return writes()
    .filter(([group, , message]) => group === agentGroupId && message.kind === 'chat')
    .map(([, , message]) => (JSON.parse(message.content as string) as { text: string }).text);
}

/** Triggering chat notes back to the REQUESTER — the late-answer wake path. */
function wakes(): string[] {
  return writes()
    .filter(([group, , message]) => group === SESSION.agent_group_id && message.kind === 'chat')
    .map(([, , message]) => (JSON.parse(message.content as string) as { text: string }).text);
}

function liveGrant(approvalId: string, payload: Record<string, unknown>): PendingApproval {
  const row = {
    approval_id: approvalId,
    session_id: SESSION.id,
    request_id: approvalId,
    action: 'create_worker',
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    agent_group_id: 'ag-1',
    channel_type: null,
    platform_id: null,
    platform_message_id: null,
    expires_at: null,
    status: 'pending',
    title: '',
    options_json: '[]',
    approver_user_id: null,
  } as PendingApproval;
  liveApprovals.set(approvalId, row);
  return row;
}

function makeRepo(): void {
  fs.mkdirSync(WORKER_REPOS_ROOT, { recursive: true });
  const repoDir = path.join(WORKER_REPOS_ROOT, REPO);
  if (fs.existsSync(repoDir)) return;
  fs.mkdirSync(repoDir, { recursive: true });
  const run = (args: string[]): void => void execFileSync('git', ['-C', repoDir, ...args], { stdio: 'ignore' });
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# demo\n');
  run(['add', '.']);
  run(['commit', '-m', 'init']);
}

beforeEach(() => {
  vi.clearAllMocks();
  liveApprovals.clear();
  mockFindWorkerForOrigin.mockResolvedValue(undefined);
  mockGetDestinationByTarget.mockResolvedValue(undefined);
  mockGetMessagePolicy.mockResolvedValue(undefined);
  mockHasDestination.mockResolvedValue(true);
  makeRepo();
});

afterEach(() => {
  fs.rmSync(WORKTREE, { recursive: true, force: true });
  fs.rmSync(WORKER_TEST_ROOT, { recursive: true, force: true });
});

describe('create_worker — one call creates the worker and briefs it', () => {
  it('creates the worktree, stamps it as the cwd, and delivers the task in the SAME request', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateWorker(request());

    const group = mockCreateAgentGroup.mock.calls[0][0] as { id: string; workspace_path: string };
    expect(fs.existsSync(path.join(group.workspace_path, 'README.md'))).toBe(true);
    // OUTSIDE the repository: the memory walk climbs past a worktree into its
    // parent checkout, so a worktree inside the repo would load the outer
    // checkout's CLAUDE.md on top of its own.
    expect(group.workspace_path.startsWith(path.join(WORKER_REPOS_ROOT, REPO))).toBe(false);

    // The brief, delivered without the caller ever being woken to send it.
    expect(briefsTo(group.id)).toEqual(['Audit the gates and report what fails.']);
  });

  it('stamps the originating session, which is what makes the worker reusable', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateWorker(request());

    expect(mockCreateAgentGroup.mock.calls[0][0]).toMatchObject({ origin_session_id: SESSION.id });
  });

  it('answers the blocking tool with the worker name and the asynchronous contract', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateWorker(request());

    const answer = response();
    expect(answer?.status).toBe('created');
    expect(answer?.result.message).toContain('"scout"');
    expect(answer?.result.message).toContain(REPO);
    expect(answer?.result.message).toContain('ANSWER will arrive later');
  });

  it('does not wake the caller while its wait window is still open', async () => {
    // The tool is polling. A second, triggering copy of the same answer would
    // spend a whole extra turn saying what the tool already returned.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateWorker(request());

    expect(wakes()).toEqual([]);
  });

  it('wakes the caller when the answer lands after its wait ran out', async () => {
    // A large checkout can outrun the bound. The tool has already returned
    // "you will be notified", so the response row alone reaches nobody.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateWorker(request({ waitUntil: Date.now() - 1 }));

    expect(wakes()).toHaveLength(1);
    expect(wakes()[0]).toContain('"scout"');
  });
});

describe('create_worker — the task is delivered verbatim', () => {
  it('passes a slash-command task through unwrapped, unquoted and unprefixed', async () => {
    // A `task` beginning with '/' is dispatched as a real command inside the
    // worker's session (categorizeMessage → passthrough → raw to the SDK), so
    // this repository's commands and skills run there. Wrap, quote or prefix
    // it and the command silently degrades to prose, and the worker
    // improvises a plausible answer instead.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateWorker(request({ task: '/blueprint FMTA-343' }));

    const group = mockCreateAgentGroup.mock.calls[0][0] as { id: string };
    expect(briefsTo(group.id)).toEqual(['/blueprint FMTA-343']);
  });
});

describe('create_worker — reuse for one (repo, thread) pair', () => {
  const EXISTING = {
    id: 'ag-worker-1',
    name: 'Scout',
    folder: 'scout',
    agent_provider: null,
    created_at: '',
    workspace_path: WORKTREE,
    origin_session_id: SESSION.id,
  };

  it('looks the worker up by the (repo, thread) pair, keyed on the derived worktree', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockFindWorkerForOrigin.mockResolvedValue(EXISTING);
    mockGetDestinationByTarget.mockResolvedValue({ local_name: 'scout' });

    await runCreateWorker(request());

    expect(mockFindWorkerForOrigin).toHaveBeenCalledWith(SESSION.id, WORKTREE);
  });

  it('returns the SAME worker and still delivers the new task to it', async () => {
    // A second worker would stand on a second branch and could not see a line
    // of the first one's work — but the task must not be dropped along with
    // the duplicate.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockFindWorkerForOrigin.mockResolvedValue(EXISTING);
    mockGetDestinationByTarget.mockResolvedValue({ local_name: 'scout' });

    await runCreateWorker(request({ task: 'Now run the gates.' }));

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(briefsTo(EXISTING.id)).toEqual(['Now run the gates.']);
    const answer = response();
    expect(answer?.status).toBe('reused');
    expect(answer?.result.message).toContain('"scout"');
  });

  it('never cards an admin for a reuse — the privilege was already granted', async () => {
    // `group` is the confined default, which normally holds. There is nothing
    // to approve: the worker, its worktree and the destination row all exist.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockFindWorkerForOrigin.mockResolvedValue(EXISTING);
    mockGetDestinationByTarget.mockResolvedValue({ local_name: 'scout' });

    await runCreateWorker(request());

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('creates a reachable worker when the existing one has no destination row', async () => {
    // An unaddressable worker is not reuse: handing back a name send_message
    // cannot resolve is worse than a second agent.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockFindWorkerForOrigin.mockResolvedValue(EXISTING);
    mockGetDestinationByTarget.mockResolvedValue(undefined);

    await runCreateWorker(request());

    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
  });

  it('reuses on an approved replay, so a card approved twice yields one worker', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockFindWorkerForOrigin.mockResolvedValue(EXISTING);
    mockGetDestinationByTarget.mockResolvedValue({ local_name: 'scout' });
    const payload = { name: 'Scout', repo: REPO, task: 'go', requestId: 'req-w1', waitUntil: Date.now() + 60_000 };

    await approvalHandlers.get('create_worker')!({
      session: SESSION,
      payload,
      approval: liveGrant('appr-w-reuse', payload),
      userId: 'telegram:admin',
      notify: vi.fn(),
    });

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });
});

describe('create_worker — an unresolvable repo never falls back', () => {
  it('refuses a repo outside the allowlist and creates nothing', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateWorker(request({ repo: '../../etc' }));

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockInitGroupFilesystem).not.toHaveBeenCalled();
  });

  it('refuses an absolute path, and never falls back to the group folder', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateWorker(request({ repo: path.join(WORKER_REPOS_ROOT, REPO) }));

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('errors to the blocking tool, naming the allowlist', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateWorker(request({ repo: 'no-such-repo' }));

    const answer = response();
    expect(answer?.status).toBe('error');
    expect(answer?.result.error).toContain('no-such-repo');
    expect(answer?.result.error).toContain(WORKER_REPOS_ROOT);
  });

  it('refuses an unknown repo without ever carding an admin', async () => {
    // A hold spends the one human in the loop on a request that cannot succeed.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await runCreateWorker(request({ repo: 'no-such-repo' }));

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('requires a task, and says so rather than creating a worker with no brief', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateWorker(request({ task: '' }));

    expect(response()?.status).toBe('error');
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });
});

describe('create_worker — approval returns immediately, never blocks', () => {
  it('answers `pending` in the same request that raises the card', async () => {
    // An approval can sit for hours and the tool waits one minute. Blocking
    // would guarantee a timeout and leave the caller unable to tell "waiting
    // on a human" from "still checking out a large repository".
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await runCreateWorker(request());

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    const answer = response();
    expect(answer?.status).toBe('pending');
    expect(answer?.result.message).toContain('admin approval');
    expect(answer?.result.message).toContain('waiting');
    // The tool is still polling, so the card must not also cost a wake.
    expect(wakes()).toEqual([]);
  });

  it('carries repo, task, requestId and waitUntil into the payload, so approval drops none of them', async () => {
    // The approved replay re-enters this action with the APPROVAL ROW as its
    // content. Anything missing here is silently gone on approve.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await runCreateWorker(request());

    const card = mockRequestApproval.mock.calls[0][0] as { payload: Record<string, unknown>; question: string };
    expect(card.payload).toMatchObject({ name: 'Scout', repo: REPO, requestId: 'req-w1' });
    expect(card.payload.task).toBe('Audit the gates and report what fails.');
    expect(typeof card.payload.waitUntil).toBe('number');
    expect(card.question).toContain(REPO);
  });

  it('creates and briefs on an approved replay, and wakes the caller because the tool is long gone', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const payload = {
      name: 'Scout',
      repo: REPO,
      task: 'Audit the gates.',
      requestId: 'req-w1',
      waitUntil: Date.now() - 60_000,
    };

    await approvalHandlers.get('create_worker')!({
      session: SESSION,
      payload,
      approval: liveGrant('appr-w-1', payload),
      userId: 'telegram:admin',
      notify: vi.fn(),
    });

    const group = mockCreateAgentGroup.mock.calls[0][0] as { id: string; workspace_path: string };
    expect(fs.existsSync(group.workspace_path)).toBe(true);
    expect(briefsTo(group.id)).toEqual(['Audit the gates.']);
    expect(wakes()).toHaveLength(1);
  });

  it('refuses a replay whose grant was approved for a different request', async () => {
    // The grant binds on requestId, not on the worker name: two requests can
    // ask for the same name, and one approval must not satisfy the other.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const approval = liveGrant('appr-w-2', { name: 'Scout', repo: REPO, task: 'x', requestId: 'other-request' });

    await approvalHandlers.get('create_worker')!({
      session: SESSION,
      payload: { ...request(), instructions: null },
      approval,
      userId: 'telegram:admin',
      notify: vi.fn(),
    });

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockRequestApproval).not.toHaveBeenCalled(); // refused, not re-held
  });
});

describe('create_agent — no longer takes a repo', () => {
  it('ignores a repo key and creates an ordinary companion with no worktree', async () => {
    // The MCP tool that could send one is gone, but the delivery action is
    // still reachable (slack-agent-flow registers over it). A stray `repo` on
    // that path must not resurrect a half-configured worker: no worktree, no
    // originating conversation, so nothing can later be handed it as a reused
    // worker.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await getDeliveryAction('create_agent')!({ name: 'Companion', repo: REPO }, SESSION);

    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentGroup.mock.calls[0][0]).toMatchObject({
      workspace_path: null,
      origin_session_id: null,
    });
  });
});
