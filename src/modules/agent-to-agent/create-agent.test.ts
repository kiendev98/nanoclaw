/**
 * Tests for create_agent host-side authorization.
 *
 * Regression guard for the audit finding: `create_agent` is a privileged
 * central-DB write with no host-side authz. Authorization is the guard's
 * `agents.create` decision — trusted owner agent groups ('global') create
 * directly; confined groups ('group', the default and the prompt-injection
 * victim) hold for admin approval. These tests drive the REAL wrapped
 * delivery action (the only reachable path) and the approve continuation's
 * grant-carrying re-entry.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingApproval, Session } from '../../types.js';

// The folder-dedupe loop is disk-aware (A4): point GROUPS_DIR at a temp root
// so the residue-skip test controls what is on disk. Absent for every other
// test, so their behavior is unchanged.
const A2A_TEST_ROOT = '/tmp/nanoclaw-test-a2a-create-agent';
const A2A_REPOS_ROOT = '/tmp/nanoclaw-test-a2a-create-agent/repos';
// PROJECT_ROOTS is the allowlist a `repo` argument is resolved against. Empty
// in a real install unless the operator sets NANOCLAW_PROJECT_ROOTS, so the
// repo tests below need one; every other test in this file passes no `repo`
// and never consults it. Literals, not the consts above: vi.mock is hoisted
// over them.
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-test-a2a-create-agent/groups',
  PROJECT_ROOTS: ['/tmp/nanoclaw-test-a2a-create-agent/repos'],
}));

// Mocks for the collaborators the branch decides between / depends on.
// vi.hoisted: the module barrel import below runs before this file's const
// initializers, and the mock factories close over this state.
const {
  mockRequestApproval,
  mockGetContainerConfig,
  mockCreateAgentGroup,
  mockInitGroupFilesystem,
  mockWriteDestinations,
  mockNotifyWrite,
  mockFindWorkerForOrigin,
  mockGetDestinationByTarget,
  liveApprovals,
  approvalHandlers,
} = vi.hoisted(() => ({
  mockRequestApproval: vi.fn().mockResolvedValue(undefined),
  mockGetContainerConfig: vi.fn(),
  mockCreateAgentGroup: vi.fn(),
  mockInitGroupFilesystem: vi.fn(),
  mockWriteDestinations: vi.fn(),
  mockNotifyWrite: vi.fn(),
  mockFindWorkerForOrigin: vi.fn().mockResolvedValue(undefined),
  mockGetDestinationByTarget: vi.fn().mockResolvedValue(undefined),
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
  hasDestination: () => true,
  normalizeName: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));
// notifyAgent writes to the session inbound.db + wakes the container; stub both.
// delivery.ts and agent-route.ts pull more session-manager exports at import time.
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...a: unknown[]) => mockNotifyWrite(...a),
  openInboundDb: vi.fn(),
  openOutboundDb: vi.fn(),
  clearOutbox: vi.fn(),
  readOutboxFiles: vi.fn().mockReturnValue([]),
  resolveSession: vi.fn(),
  sessionDir: vi.fn().mockReturnValue('/tmp/nowhere'),
}));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../db/sessions.js', () => ({
  getSession: (id: string) => ({ id, agent_group_id: 'ag-1' }),
  getPendingApproval: (id: string) => liveApprovals.get(id),
  getRunningSessions: () => [],
  getActiveSessions: () => [],
  createPendingQuestion: vi.fn(),
}));

// The a2a module barrel registers ./guard.js (catalog entries) and the
// guard-wrapped create_agent delivery action — the path under test.
import './index.js';
import { getDeliveryAction } from '../../delivery.js';

const SESSION = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;

async function runCreateAgent(content: Record<string, unknown>): Promise<void> {
  const wrapped = getDeliveryAction('create_agent');
  expect(wrapped).toBeDefined();
  await wrapped!(content, SESSION);
}

function liveGrant(approvalId: string, payload: Record<string, unknown>): PendingApproval {
  const row = {
    approval_id: approvalId,
    session_id: SESSION.id,
    request_id: approvalId,
    action: 'create_agent',
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

beforeEach(() => {
  vi.clearAllMocks();
  liveApprovals.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('create_agent — guard-based authorization (wrapped delivery action)', () => {
  it('global scope: creates directly, no approval requested', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateAgent({ name: 'Scout', instructions: 'help' });

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    expect(mockInitGroupFilesystem).toHaveBeenCalledTimes(1);
  });

  it('child inherits the creator provider (codex parent → codex child)', async () => {
    // A subagent must run on the same authenticated runtime as its creator —
    // on a codex-only install a claude default would 401. The provider is
    // passed to initGroupFilesystem, which stamps the child's config row.
    // Red-on-delete: dropping the inheritance lets the child fall through to the
    // instance default instead of codex.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global', provider: 'codex' });

    await runCreateAgent({ name: 'Scout', instructions: 'help' });

    expect(mockInitGroupFilesystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: 'codex' }),
    );
  });

  it('claude creator pins the child to claude, not the instance default', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' }); // parent has no explicit provider

    await runCreateAgent({ name: 'Scout', instructions: 'help' });

    // The child inherits the parent's EFFECTIVE provider (claude), passed
    // explicitly so it never falls through to a non-claude instance default.
    expect(mockInitGroupFilesystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: 'claude' }),
    );
  });

  it('group scope (default): requires approval, does NOT create directly', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await runCreateAgent({ name: 'Scout', instructions: 'help' });

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockRequestApproval.mock.calls[0][0]).toMatchObject({ action: 'create_agent' });
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockInitGroupFilesystem).not.toHaveBeenCalled();
  });

  it('missing config: fails closed to approval (no direct create)', async () => {
    mockGetContainerConfig.mockReturnValue(undefined);

    await runCreateAgent({ name: 'Scout' });

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('disabled/other scope: requires approval', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'disabled' });

    await runCreateAgent({ name: 'Scout' });

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('empty name: neither creates nor requests approval', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateAgent({ name: '' });

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('skips deleted-group residue on disk when minting the folder (A4)', async () => {
    // groups/scout exists on disk but no DB row claims it (the mocked
    // getAgentGroupByFolder always returns undefined) — exactly the state
    // `ncl groups delete` leaves behind. The dedupe loop must treat disk
    // presence as taken and mint scout-2, never adopt the residue.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    fs.mkdirSync(path.join(A2A_TEST_ROOT, 'groups', 'scout'), { recursive: true });
    try {
      await runCreateAgent({ name: 'Scout', instructions: 'help' });

      expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
      expect(mockCreateAgentGroup.mock.calls[0][0]).toMatchObject({ folder: 'scout-2' });
    } finally {
      fs.rmSync(A2A_TEST_ROOT, { recursive: true, force: true });
    }
  });
});

describe('create_agent — approved replay (grant-carrying re-entry)', () => {
  it('valid grant executes exactly once — decide hold is satisfied, create runs', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const payload = { name: 'Scout', instructions: 'help' };
    const approval = liveGrant('appr-ca-1', payload);

    const continuation = approvalHandlers.get('create_agent');
    expect(continuation).toBeDefined();
    await continuation!({ session: SESSION, payload, approval, userId: 'telegram:admin', notify: vi.fn() });

    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    expect(mockRequestApproval).not.toHaveBeenCalled(); // no second card
  });

  it('dead grant (row already resolved) refuses the replay', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const payload = { name: 'Scout', instructions: 'help' };
    const approval = liveGrant('appr-ca-2', payload);
    liveApprovals.delete('appr-ca-2'); // resolution consumed the row

    await approvalHandlers.get('create_agent')!({
      session: SESSION,
      payload,
      approval,
      userId: 'telegram:admin',
      notify: vi.fn(),
    });

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockRequestApproval).not.toHaveBeenCalled(); // refused, not re-held
  });

  it('mismatched grant (approved for a different name) refuses the replay', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const approval = liveGrant('appr-ca-3', { name: 'OtherAgent' });

    await approvalHandlers.get('create_agent')!({
      session: SESSION,
      payload: { name: 'Scout' },
      approval,
      userId: 'telegram:admin',
      notify: vi.fn(),
    });

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });
});

/**
 * `repo` decides the new agent's WORKING directory, and cwd is the only thing
 * that decides which repository's CLAUDE.md, `.claude/skills/` and
 * `.claude/settings.json` that agent loads. It arrives from the untrusted
 * container, so it is a NAME resolved against the operator's allowlist — never
 * a path — and a name that does not resolve must abort the creation. A fallback
 * to the group folder would produce a worker that looks healthy while standing
 * in the wrong directory.
 */
describe('create_agent — repo-scoped workers', () => {
  const REPO = 'demo-repo';
  let created: string | null = null;

  beforeEach(() => {
    fs.mkdirSync(A2A_REPOS_ROOT, { recursive: true });
    const repoDir = path.join(A2A_REPOS_ROOT, REPO);
    if (!fs.existsSync(repoDir)) {
      fs.mkdirSync(repoDir, { recursive: true });
      const run = (args: string[]): void => void execFileSync('git', ['-C', repoDir, ...args], { stdio: 'ignore' });
      run(['init', '-b', 'main']);
      run(['config', 'user.email', 'test@example.com']);
      run(['config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(repoDir, 'README.md'), '# demo\n');
      run(['add', '.']);
      run(['commit', '-m', 'init']);
    }
    created = null;
  });

  afterEach(() => {
    if (created) fs.rmSync(created, { recursive: true, force: true });
    fs.rmSync(A2A_TEST_ROOT, { recursive: true, force: true });
  });

  it('stores the worktree path on the new group, so the spawn can use it as cwd', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateAgent({ name: 'Scout', repo: REPO });

    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    const group = mockCreateAgentGroup.mock.calls[0][0] as { workspace_path: string; folder: string };
    created = group.workspace_path;

    expect(fs.existsSync(path.join(group.workspace_path, 'README.md'))).toBe(true);
    // OUTSIDE the repository: the memory walk climbs past a worktree into its
    // parent checkout, so a worktree inside the repo would load the outer
    // checkout's CLAUDE.md on top of its own.
    expect(group.workspace_path.startsWith(path.join(A2A_REPOS_ROOT, REPO))).toBe(false);
  });

  it('leaves workspace_path null when no repo is named — an ordinary agent is unchanged', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateAgent({ name: 'Scout' });

    expect(mockCreateAgentGroup.mock.calls[0][0]).toMatchObject({ workspace_path: null });
  });

  it('refuses a repo outside the allowlist and creates nothing', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateAgent({ name: 'Scout', repo: '../../etc' });

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockInitGroupFilesystem).not.toHaveBeenCalled();
  });

  it('refuses an absolute path, and never falls back to the group folder', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateAgent({ name: 'Scout', repo: path.join(A2A_REPOS_ROOT, REPO) });

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('refuses an unknown repo without ever carding an admin', async () => {
    // A hold spends the one human in the loop on a request that cannot succeed.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await runCreateAgent({ name: 'Scout', repo: 'no-such-repo' });

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('carries the repo into the approval payload, so approval does not drop it', async () => {
    // The approved replay re-enters the action with the APPROVAL ROW as its
    // content. A repo missing from the payload comes back as an unscoped agent.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await runCreateAgent({ name: 'Scout', repo: REPO });

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    const card = mockRequestApproval.mock.calls[0][0] as { payload: Record<string, unknown>; question: string };
    expect(card.payload).toMatchObject({ name: 'Scout', repo: REPO });
    expect(card.question).toContain(REPO);
  });

  it('creates the worktree on an approved replay', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const payload = { name: 'Scout', instructions: null, repo: REPO };
    const approval = liveGrant('appr-ca-repo', payload);

    await approvalHandlers.get('create_agent')!({
      session: SESSION,
      payload,
      approval,
      userId: 'telegram:admin',
      notify: vi.fn(),
    });

    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    const group = mockCreateAgentGroup.mock.calls[0][0] as { workspace_path: string };
    created = group.workspace_path;
    expect(fs.existsSync(created)).toBe(true);
  });
});

/**
 * One worker per (repository, thread), not one per command.
 *
 * A second `create_agent({ repo })` in the same thread used to mint a second
 * agent on a second branch in a second worktree. That worker could not see a
 * line of the first one's work, so one conversation held two agents answering
 * about the same repository with nothing to say which was current — the main
 * trap of the whole feature.
 */
describe('create_agent — worker reuse for one (repo, thread) pair', () => {
  const REPO = 'demo-repo';
  const WORKTREE = path.join(
    process.env.HOME || '',
    '.config',
    'nanoclaw',
    'worktrees',
    `${REPO}-nanoclaw-${SESSION.id}`,
  );
  const EXISTING = {
    id: 'ag-worker-1',
    name: 'Scout',
    folder: 'scout',
    agent_provider: null,
    created_at: '',
    workspace_path: WORKTREE,
    origin_session_id: SESSION.id,
  };

  beforeEach(() => {
    fs.mkdirSync(A2A_REPOS_ROOT, { recursive: true });
    const repoDir = path.join(A2A_REPOS_ROOT, REPO);
    if (!fs.existsSync(repoDir)) {
      fs.mkdirSync(repoDir, { recursive: true });
      const run = (args: string[]): void => void execFileSync('git', ['-C', repoDir, ...args], { stdio: 'ignore' });
      run(['init', '-b', 'main']);
      run(['config', 'user.email', 'test@example.com']);
      run(['config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(repoDir, 'README.md'), '# demo\n');
      run(['add', '.']);
      run(['commit', '-m', 'init']);
    }
    mockFindWorkerForOrigin.mockResolvedValue(undefined);
    mockGetDestinationByTarget.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Some cases below deliberately DO create a worker, so the worktree has to
    // go even though the reuse cases never make one.
    fs.rmSync(WORKTREE, { recursive: true, force: true });
    fs.rmSync(A2A_TEST_ROOT, { recursive: true, force: true });
  });

  it('looks the worker up by the (repo, thread) pair, keyed on the derived worktree', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockFindWorkerForOrigin.mockResolvedValue(EXISTING);
    mockGetDestinationByTarget.mockResolvedValue({ local_name: 'scout' });

    await runCreateAgent({ name: 'Scout', repo: REPO });

    // The key is (origin session, worktree path), and the worktree path is a
    // pure function of (repo, origin session) — so one thread can hold one
    // worker per repository, and the same repo in another thread is another
    // worker.
    expect(mockFindWorkerForOrigin).toHaveBeenCalledWith(SESSION.id, WORKTREE);
  });

  it('returns the SAME worker rather than creating a second one', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockFindWorkerForOrigin.mockResolvedValue(EXISTING);
    mockGetDestinationByTarget.mockResolvedValue({ local_name: 'scout' });

    await runCreateAgent({ name: 'Scout II', repo: REPO });

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockInitGroupFilesystem).not.toHaveBeenCalled();
    // The requester is handed the handle send_message actually accepts.
    const notified = JSON.parse(mockNotifyWrite.mock.calls.at(-1)![2].content) as { text: string };
    expect(notified.text).toContain('"scout"');
    expect(notified.text).toContain(REPO);
  });

  it('never cards an admin for a reuse — the privilege was already granted', async () => {
    // `group` scope is the confined default, which normally holds. There is
    // nothing to approve: the worker, its worktree and the destination row
    // all exist.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockFindWorkerForOrigin.mockResolvedValue(EXISTING);
    mockGetDestinationByTarget.mockResolvedValue({ local_name: 'scout' });

    await runCreateAgent({ name: 'Scout', repo: REPO });

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('creates a reachable worker when the existing one has no destination row', async () => {
    // An unaddressable worker is not reuse: handing back a name send_message
    // cannot resolve is worse than a second agent.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockFindWorkerForOrigin.mockResolvedValue(EXISTING);
    mockGetDestinationByTarget.mockResolvedValue(undefined);

    await runCreateAgent({ name: 'Scout', repo: REPO });

    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
  });

  it('reuses on an approved replay, so a card approved twice yields one worker', async () => {
    // An approval can sit for hours. Re-entering with the approval row as the
    // content must not create a rival for a thread that gained a worker in the
    // meantime.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockFindWorkerForOrigin.mockResolvedValue(EXISTING);
    mockGetDestinationByTarget.mockResolvedValue({ local_name: 'scout' });
    const payload = { name: 'Scout', instructions: null, repo: REPO };

    await approvalHandlers.get('create_agent')!({
      session: SESSION,
      payload,
      approval: liveGrant('appr-ca-reuse', payload),
      userId: 'telegram:admin',
      notify: vi.fn(),
    });

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('stamps the originating session on a fresh worker, and leaves it NULL otherwise', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runCreateAgent({ name: 'Scout', repo: REPO });
    expect(mockCreateAgentGroup.mock.calls[0][0]).toMatchObject({ origin_session_id: SESSION.id });

    mockCreateAgentGroup.mockClear();
    await runCreateAgent({ name: 'Plain' });
    // An ordinary sub-agent belongs to its creator, not to a conversation, so
    // it can never be handed back as a reused worker.
    expect(mockCreateAgentGroup.mock.calls[0][0]).toMatchObject({ origin_session_id: null });
  });
});
