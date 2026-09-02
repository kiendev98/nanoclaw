/**
 * Tests for `spawn_worker` — the one call that creates or reuses a repo
 * worker AND briefs it.
 *
 * Three properties carry the feature, and each fails silently if it breaks:
 *
 * - **One call does everything.** Creation and the brief happen in the same
 *   request. The old shape woke the caller merely to say the worker existed,
 *   and the brief went out a turn later.
 * - **Creating a worker never requires admin approval, for any cli_scope.**
 *   The containment is the operator's repo allowlist (below), not a hold —
 *   see `describe('spawn_worker — no approval gate, for any cli_scope')`.
 *   The container tool's own wait is still bounded at one minute, because a
 *   worktree checkout can outrun it; every late answer WAKES the caller,
 *   because a response row nobody is polling any more is silence.
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

import type { Session } from '../../types.js';

const WORKER_TEST_ROOT = '/tmp/nanoclaw-test-a2a-spawn-worker';
const WORKER_REPOS_ROOT = '/tmp/nanoclaw-test-a2a-spawn-worker/repos';
// PROJECT_ROOTS is the allowlist a `repo` argument is resolved against, and it
// is EMPTY in a real install unless the operator sets NANOCLAW_PROJECT_ROOTS.
// Literals, not the consts above: vi.mock is hoisted over them.
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-test-a2a-spawn-worker/groups',
  PROJECT_ROOTS: ['/tmp/nanoclaw-test-a2a-spawn-worker/repos'],
}));

const {
  mockRequestApproval,
  mockGetContainerConfig,
  mockCreateAgentGroup,
  mockUpdateAgentGroup,
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
  mockUpdateAgentGroup: vi.fn(),
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
  updateAgentGroup: (...a: unknown[]) => mockUpdateAgentGroup(...a),
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
import { workerWorkspace } from './worker-identity.js';

const SESSION = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;
const REPO = 'demo-repo';
// The repository has to exist BEFORE the worktree path is derived: the
// fingerprint canonicalizes through `realpathSync`, and on macOS the answer for
// `/tmp/...` is `/private/tmp/...`. Derived from a path that is not there yet,
// it would silently fall back to the uncanonicalized form and disagree with
// every path the code under test computes. `makeRepo` is idempotent and
// hoisted, so calling it here costs nothing and `beforeEach` still re-makes it.
makeRepo();
// Derived, never hand-spelled: a literal would duplicate `repoFingerprint` and
// re-freeze the very format these tests are meant to outlive.
const WORKTREE = workerWorkspace(path.join(WORKER_REPOS_ROOT, REPO), SESSION.id);

/** A request as the container tool writes it — still inside its wait window. */
function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'spawn_worker',
    requestId: 'req-w1',
    waitUntil: Date.now() + 60_000,
    repo: REPO,
    task: 'Audit the gates and report what fails.',
    name: 'Scout',
    ...over,
  };
}

async function runSpawnWorker(content: Record<string, unknown>): Promise<void> {
  const wrapped = getDeliveryAction('spawn_worker');
  expect(wrapped).toBeDefined();
  await wrapped!(content, SESSION);
}

/** Every `writeSessionMessage` call, as (agentGroupId, sessionId, message). */
function writes(): Array<[string, string, Record<string, unknown>]> {
  return mockSessionWrite.mock.calls as Array<[string, string, Record<string, unknown>]>;
}

/** The `spawn_worker` response row the blocking container tool polls for. */
function response(): { status: string; result: Record<string, string> } | undefined {
  for (const [, , message] of writes()) {
    if (message.kind !== 'system') continue;
    const parsed = JSON.parse(message.content as string) as {
      type?: string;
      status: string;
      result: Record<string, string>;
    };
    if (parsed.type === 'spawn_worker_response') return parsed;
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

describe('spawn_worker — one call creates the worker and briefs it', () => {
  it('creates the worktree, stamps it as the cwd, and delivers the task in the SAME request', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runSpawnWorker(request());

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

    await runSpawnWorker(request());

    expect(mockCreateAgentGroup.mock.calls[0][0]).toMatchObject({ origin_session_id: SESSION.id });
  });

  it('answers the blocking tool with the worker name and the asynchronous contract', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runSpawnWorker(request());

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

    await runSpawnWorker(request());

    expect(wakes()).toEqual([]);
  });

  it('wakes the caller when the answer lands after its wait ran out', async () => {
    // A large checkout can outrun the bound. The tool has already returned
    // "you will be notified", so the response row alone reaches nobody.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runSpawnWorker(request({ waitUntil: Date.now() - 1 }));

    expect(wakes()).toHaveLength(1);
    expect(wakes()[0]).toContain('"scout"');
  });
});

describe('spawn_worker — the task is delivered verbatim', () => {
  it('passes a slash-command task through unwrapped, unquoted and unprefixed', async () => {
    // A `task` beginning with '/' is dispatched as a real command inside the
    // worker's session (categorizeMessage → passthrough → raw to the SDK), so
    // this repository's commands and skills run there. Wrap, quote or prefix
    // it and the command silently degrades to prose, and the worker
    // improvises a plausible answer instead.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runSpawnWorker(request({ task: '/blueprint FMTA-343' }));

    const group = mockCreateAgentGroup.mock.calls[0][0] as { id: string };
    expect(briefsTo(group.id)).toEqual(['/blueprint FMTA-343']);
  });
});

describe('spawn_worker — reuse for one (repo, thread) pair', () => {
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

    await runSpawnWorker(request());

    expect(mockFindWorkerForOrigin).toHaveBeenCalledWith(SESSION.id, WORKTREE);
  });

  it('returns the SAME worker and still delivers the new task to it', async () => {
    // A second worker would stand on a second branch and could not see a line
    // of the first one's work — but the task must not be dropped along with
    // the duplicate.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockFindWorkerForOrigin.mockResolvedValue(EXISTING);
    mockGetDestinationByTarget.mockResolvedValue({ local_name: 'scout' });

    await runSpawnWorker(request({ task: 'Now run the gates.' }));

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(briefsTo(EXISTING.id)).toEqual(['Now run the gates.']);
    const answer = response();
    expect(answer?.status).toBe('reused');
    expect(answer?.result.message).toContain('"scout"');
  });

  it('re-creates the worktree when it was pruned out from under the worker', async () => {
    // `ncl worktrees prune` removes a CLEAN worktree and deliberately leaves
    // `agent_groups` alone, and a human can `rm -rf` one just as easily. The
    // group row therefore outlives its directory, and reuse must put it back:
    // otherwise the brief is delivered and the spawn then chdirs into a path
    // that is not there. Clearing `workspace_path` on prune is the WRONG fix —
    // the reuse lookup keys on that column, so clearing it mints a second
    // worker on a second branch for one thread.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockFindWorkerForOrigin.mockResolvedValue(EXISTING);
    mockGetDestinationByTarget.mockResolvedValue({ local_name: 'scout' });
    fs.rmSync(WORKTREE, { recursive: true, force: true });
    expect(fs.existsSync(WORKTREE)).toBe(false);

    await runSpawnWorker(request({ task: 'Carry on.' }));

    expect(fs.existsSync(WORKTREE)).toBe(true);
    expect(briefsTo(EXISTING.id)).toEqual(['Carry on.']);
    expect(response()?.status).toBe('reused');
    // The derivation still agrees with the stored column, so nothing is
    // re-stamped. The update exists for the case where it stops agreeing.
    expect(mockUpdateAgentGroup).not.toHaveBeenCalled();
  });

  it('never cards an admin for a reuse — creating a worker never holds, at any cli_scope', async () => {
    // `group` is the confined default for create_agent, but spawn_worker's
    // decision never holds regardless of scope — there is nothing to approve
    // here either way: the worker, its worktree and the destination row all
    // exist already.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockFindWorkerForOrigin.mockResolvedValue(EXISTING);
    mockGetDestinationByTarget.mockResolvedValue({ local_name: 'scout' });

    await runSpawnWorker(request());

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('creates a reachable worker when the existing one has no destination row', async () => {
    // An unaddressable worker is not reuse: handing back a name send_message
    // cannot resolve is worse than a second agent.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockFindWorkerForOrigin.mockResolvedValue(EXISTING);
    mockGetDestinationByTarget.mockResolvedValue(undefined);

    await runSpawnWorker(request());

    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
  });
});

describe('spawn_worker — an unresolvable repo never falls back', () => {
  it('refuses a repo outside the allowlist and creates nothing', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runSpawnWorker(request({ repo: '../../etc' }));

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockInitGroupFilesystem).not.toHaveBeenCalled();
  });

  it('refuses an absolute path, and never falls back to the group folder', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runSpawnWorker(request({ repo: path.join(WORKER_REPOS_ROOT, REPO) }));

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('errors to the blocking tool, naming the allowlist', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runSpawnWorker(request({ repo: 'no-such-repo' }));

    const answer = response();
    expect(answer?.status).toBe('error');
    expect(answer?.result.error).toContain('no-such-repo');
    expect(answer?.result.error).toContain(WORKER_REPOS_ROOT);
  });

  it('refuses an unknown repo without ever carding an admin', async () => {
    // spawn_worker never holds regardless of cli_scope, but this failure is
    // resolved in the precheck, before the guard is even consulted — an
    // unresolvable repo is a request that cannot succeed either way.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await runSpawnWorker(request({ repo: 'no-such-repo' }));

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('requires a task, and says so rather than creating a worker with no brief', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runSpawnWorker(request({ task: '' }));

    expect(response()?.status).toBe('error');
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });
});

describe('spawn_worker — no approval gate, for any cli_scope', () => {
  it('creates and briefs a FRESH worker directly under `group` scope — no approval card, no pending response', async () => {
    // The rule this whole change pins: spawn_worker never holds, so `group`
    // — the confined default that still holds create_agent — must create
    // directly here instead. Flipping this mock to `global` would hide the
    // exact regression this test exists to catch.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await runSpawnWorker(request());

    expect(mockRequestApproval).not.toHaveBeenCalled();
    const group = mockCreateAgentGroup.mock.calls[0][0] as { id: string };
    expect(briefsTo(group.id)).toEqual(['Audit the gates and report what fails.']);
    const answer = response();
    expect(answer?.status).toBe('created');
    expect(answer?.status).not.toBe('pending');
  });
});

describe('create_agent — no longer takes a repo', () => {
  it('still holds for `group` scope — the guard rail against this change leaking into create_agent', async () => {
    // spawn_worker's own guard rewrite must not have touched agents.create:
    // a confined (default `group`) agent group still needs admin approval to
    // create an ordinary companion agent.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await getDeliveryAction('create_agent')!({ name: 'Companion' }, SESSION);

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockRequestApproval.mock.calls[0][0]).toMatchObject({ action: 'create_agent' });
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('ignores a repo key and creates an ordinary companion with no worktree', async () => {
    // The MCP tool that could send one is gone, but the delivery action is
    // still reachable (slack-agent-flow registers over it). A stray `repo` on
    // that path must not resurrect a half-configured worker: no worktree, no
    // originating conversation, so nothing can later be handed it as a reused
    // worker.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await getDeliveryAction('create_agent')!({ name: 'Companion', repo: REPO }, SESSION);

    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    // Nullish rather than strictly `null`, because the DB outcome is what this
    // guards and the caller is not where it is decided. `create-agent.ts` is
    // held byte-identical to upstream and omits both keys entirely;
    // `createAgentGroup` defaults them to null on the way to the INSERT. An
    // assertion on the argument shape would fail on an upstream file that is
    // behaving correctly, which is the opposite of what this test is for.
    const created = mockCreateAgentGroup.mock.calls[0][0];
    expect(created.workspace_path ?? null).toBeNull();
    expect(created.origin_session_id ?? null).toBeNull();
  });
});
