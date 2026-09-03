/**
 * Tests for `runTask` and `answerPendingRunRequest` — the host half of the
 * container's `run_task` tool.
 *
 * Two properties carry the fixes here, and both fail silently if they break:
 *
 * - **A failure always reaches the caller**, even a fire-and-forget call with
 *   no `requestId` — the container tool already told the agent "Queued in
 *   <repo>…" before this ever runs, so an error nobody sees is worse than an
 *   unwanted wake.
 * - **A delivery retry converges, it never forks.** The occurrence row id is
 *   derived from `runId`, and the waiter list is deduped by `requestId`, so
 *   calling with byte-identical content twice — what a retried delivery of
 *   the same outbound row does — queues exactly one run and parks exactly
 *   one waiter.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-run-task', GROUPS_DIR: '/tmp/nanoclaw-test-run-task/groups' };
});

const TEST_DIR = '/tmp/nanoclaw-test-run-task';

import { createAgentGroup, closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { findSystemSession, getSession, taskThreadId } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSession } from '../../session-manager.js';
import type { PendingRunRequest } from './run-task.js';
import { runTask } from './run-task.js';
import { workspaceSeriesId } from './create.js';

function now(): string {
  return new Date().toISOString();
}

function openInboundDb(agentGroupId: string, sessionId: string): Database.Database {
  return new Database(inboundDbPath(agentGroupId, sessionId));
}

async function seedAgent(): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('runTask — a failure always reaches the caller', () => {
  it('wakes the caller on a validation failure even with no requestId (notify: false)', async () => {
    await seedAgent();
    const { session } = await resolveSession('ag-1', null, null, 'agent-shared');

    await runTask({ instruction: '' }, session);

    const inDb = openInboundDb('ag-1', session.id);
    const rows = inDb.prepare(`SELECT kind, content FROM messages_in ORDER BY seq`).all() as Array<{
      kind: string;
      content: string;
    }>;
    inDb.close();

    // respondAndWake alone would have written nothing at all here — no
    // requestId means "fire and forget" for a SUCCESS, but not for an error.
    const wake = rows.find((r) => r.kind === 'chat');
    expect(wake).toBeDefined();
    expect(JSON.parse(wake!.content).text).toContain('instruction is required');
  });
});

describe('runTask — idempotent under a retried delivery', () => {
  it('converges a byte-identical retry on the same occurrence row and the same single waiter', async () => {
    await seedAgent();
    const { session } = await resolveSession('ag-1', null, null, 'agent-shared');

    const content = {
      instruction: 'check the feeds',
      requestId: 'req-fixed',
      waitUntil: null,
      runId: 'run-fixed',
    };

    // Same call, twice — exactly what a delivery retry of one outbound
    // system-action row looks like from runTask's side: identical content.
    await runTask(content, session);
    await runTask(content, session);

    const seriesId = workspaceSeriesId(null, session.id);
    const target = await findSystemSession('ag-1', taskThreadId(seriesId));
    expect(target).toBeDefined();

    const fresh = await getSession(target!.id);
    const waiters = JSON.parse(fresh!.pending_run_request!) as PendingRunRequest[];
    expect(waiters).toHaveLength(1);
    expect(waiters[0]!.requestId).toBe('req-fixed');

    const mbDb = openInboundDb('ag-1', target!.id);
    const occurrences = mbDb
      .prepare(`SELECT id FROM messages_in WHERE kind = 'task' AND id LIKE ?`)
      .all(`${seriesId}-run-%`) as Array<{ id: string }>;
    mbDb.close();
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.id).toBe(`${seriesId}-run-run-fixed`);
  });

  it('gives two different runIds two different occurrence rows', async () => {
    await seedAgent();
    const { session } = await resolveSession('ag-1', null, null, 'agent-shared');

    await runTask({ instruction: 'first', runId: 'run-a' }, session);
    await runTask({ instruction: 'second', runId: 'run-b' }, session);

    const seriesId = workspaceSeriesId(null, session.id);
    const target = await findSystemSession('ag-1', taskThreadId(seriesId));
    const mbDb = openInboundDb('ag-1', target!.id);
    const occurrences = mbDb
      .prepare(`SELECT id FROM messages_in WHERE kind = 'task' AND id LIKE ?`)
      .all(`${seriesId}-run-%`) as Array<{ id: string }>;
    mbDb.close();

    expect(occurrences).toHaveLength(2);
  });
});
