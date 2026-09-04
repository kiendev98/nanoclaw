/**
 * The precheck answers everything a caller can fix itself, so a mistyped
 * repository name never reaches a human as an approval card.
 *
 * The hold payload gets its own test because an approved replay re-enters the
 * handler with THAT payload as its content: a field summarised away here is a
 * field the approved call silently runs without.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from '../../../db/agent-groups.js';
import { closeDb, initTestDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { registerWorkerMigration } from '../db/migrate.js';
import type { Session } from '../../../types.js';

const { refusals, holds, deliveryFails } = vi.hoisted(() => ({
  refusals: [] as string[],
  holds: [] as Array<Record<string, unknown>>,
  deliveryFails: { value: false },
}));

vi.mock('../notify.js', () => ({
  deliverToSession: vi.fn(() => Promise.resolve(!deliveryFails.value)),
  replyToCaller: (_session: Session, text: string) => {
    refusals.push(text);
    return Promise.resolve(true);
  },
}));

vi.mock('../../approvals/index.js', () => ({
  requestApproval: (opts: { payload: Record<string, unknown> }) => {
    holds.push(opts.payload);
    return Promise.resolve();
  },
  registerApprovalHandler: vi.fn(),
  notifyAgent: vi.fn(),
}));

vi.mock('./helper-session.js', () => ({
  ensureHelperAgentGroup: (repo: { name: string; hostPath: string }) =>
    Promise.resolve({
      helper_agent_group_id: 'ag-worker',
      repo_name: repo.name,
      repo_path: repo.hostPath,
      created_at: new Date().toISOString(),
    }),
  ensureHelperSession: () =>
    Promise.resolve({ workerSession: { helper_session_id: 'sess-worker' }, session: { id: 'sess-worker' } }),
  providerOf: () => Promise.resolve('claude'),
}));

const { delegateTask, requestDelegateTaskHold, validateDelegateTask } = await import('./delegate-task.js');

const ROOTS_ENV_VAR = 'NANOCLAW_PROJECT_ROOTS';
const PRINCIPAL: Session = {
  id: 'sess-principal',
  agent_group_id: 'ag-principal',
  messaging_group_id: 'mg-1',
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: new Date().toISOString(),
};

let tempRoot: string;
let previousRoots: string | undefined;

beforeEach(async () => {
  refusals.length = 0;
  holds.length = 0;
  deliveryFails.value = false;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-delegate-'));
  fs.mkdirSync(path.join(tempRoot, 'nanoclaw', '.git'), { recursive: true });
  previousRoots = process.env[ROOTS_ENV_VAR];
  process.env[ROOTS_ENV_VAR] = tempRoot;

  registerWorkerMigration();
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-principal',
    name: 'assistant',
    folder: 'assistant',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
});

afterEach(async () => {
  if (previousRoots === undefined) delete process.env[ROOTS_ENV_VAR];
  else process.env[ROOTS_ENV_VAR] = previousRoots;
  fs.rmSync(tempRoot, { recursive: true, force: true });
  await closeDb();
});

describe('validateDelegateTask', () => {
  it('passes a named repository with a task that stands alone', async () => {
    expect(await validateDelegateTask({ repository: 'nanoclaw', task: 'add a flag' }, PRINCIPAL)).toBe(true);
    expect(refusals).toHaveLength(0);
  });

  it('refuses an unnamed repository rather than inferring one (A2)', async () => {
    expect(await validateDelegateTask({ task: 'add a flag' }, PRINCIPAL)).toBe(false);
    expect(refusals.at(-1)).toContain('Never infer it');
  });

  it('refuses an empty task', async () => {
    expect(await validateDelegateTask({ repository: 'nanoclaw', task: '  ' }, PRINCIPAL)).toBe(false);
    expect(refusals.at(-1)).toContain('stand alone');
  });

  // E1: the caller cannot list repositories itself, so the refusal does it —
  // and it never cards a human on the way.
  it('answers an unknown repository with the names it may retry with', async () => {
    expect(await validateDelegateTask({ repository: 'nanoclow', task: 'add a flag' }, PRINCIPAL)).toBe(false);
    expect(refusals.at(-1)).toContain('nanoclaw');
    expect(refusals.at(-1)).not.toContain(tempRoot);
  });

  it('refuses a session with no conversation to key a worker on', async () => {
    const detached = { ...PRINCIPAL, messaging_group_id: null };
    expect(await validateDelegateTask({ repository: 'nanoclaw', task: 'add a flag' }, detached)).toBe(false);
    expect(refusals.at(-1)).toContain('not attached to a conversation');
  });
});

describe('delegateTask', () => {
  const request = { repository: 'nanoclaw', task: 'add a flag', threadId: 'thread-1' };

  it('creates the task and tells the caller one report is coming', async () => {
    const { findRunningTask } = await import('../db/worker-tasks.js');
    await delegateTask(request, PRINCIPAL);

    expect(await findRunningTask('sess-worker')).toBeDefined();
    expect(refusals.at(-1)).toContain('exactly one report');
  });

  // A worker session is reused for a second task in the same thread, and it
  // works one at a time. Accepting a second would leave the first running with
  // nobody left to report it.
  it('refuses a second task while the worker is still on the first', async () => {
    const { findRunningTask } = await import('../db/worker-tasks.js');
    await delegateTask(request, PRINCIPAL);
    const first = await findRunningTask('sess-worker');

    await delegateTask({ ...request, task: 'and another thing' }, PRINCIPAL);

    expect(refusals.at(-1)).toContain('still on task');
    expect((await findRunningTask('sess-worker'))?.task_id).toBe(first?.task_id);
  });

  // The row is written before the delivery, so a task nobody received would sit
  // `running` for good. The caller was promised exactly one report, and it
  // would block the next delegation while waiting for work that never started.
  it('takes the task back when the worker session cannot be reached', async () => {
    const { findRunningTask } = await import('../db/worker-tasks.js');
    deliveryFails.value = true;

    await delegateTask(request, PRINCIPAL);

    expect(await findRunningTask('sess-worker')).toBeUndefined();
    expect(refusals.at(-1)).toContain('could not be reached');

    deliveryFails.value = false;
    await delegateTask(request, PRINCIPAL);

    expect(await findRunningTask('sess-worker')).toBeDefined();
    expect(refusals.at(-1)).toContain('exactly one report');
  });
});

describe('requestDelegateTaskHold', () => {
  it('cards the whole request, so an approved replay runs the call that was asked for', async () => {
    const content = { repository: 'nanoclaw', task: 'add a flag', threadId: 'thread-1' };
    await requestDelegateTaskHold(content, PRINCIPAL);

    expect(holds).toHaveLength(1);
    expect(holds[0]).toEqual(content);
  });
});
