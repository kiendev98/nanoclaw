/**
 * `spawn_worker` MCP tool tests: arg validation, the system-action row the
 * host reads, and the blocking round trip against a host-written response row
 * (the canvas_read / ask_user_question pattern).
 *
 * The bound is the point of most of these. The tool waits, but never on a
 * human — creating a worker needs no admin approval, so any non-error status
 * the host writes (`created`, `reused`) is read back the same way, and a wait
 * that runs out degrades to "you will be woken" rather than to an error — the
 * work really is still running, and calling that a failure would make the
 * caller report a failure that did not happen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { spawnWorker, defaultWorkerName } from './workers.js';

function outboundActions(): Array<{ id: string; kind: string; content: Record<string, unknown> }> {
  return (
    getOutboundDb().prepare('SELECT id, kind, content FROM messages_out ORDER BY seq').all() as Array<{
      id: string;
      kind: string;
      content: string;
    }>
  ).map((r) => ({ id: r.id, kind: r.kind, content: JSON.parse(r.content) }));
}

function seedWorkerResponse(requestId: string, status: string, result: Record<string, unknown>): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, content)
       VALUES ($id, $seq, 'system', $timestamp, 'pending', $content)`,
    )
    .run({
      $id: `worker-resp-${requestId}`,
      $seq: 2,
      $timestamp: new Date().toISOString(),
      $content: JSON.stringify({ type: 'spawn_worker_response', requestId, status, result }),
    });
}

function text(r: { content: Array<{ text: string }> }): string {
  return r.content[0].text;
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  delete process.env.NANOCLAW_CREATE_WORKER_WAIT_MS;
  closeSessionDb();
});

describe('spawn_worker — arg validation', () => {
  it('requires repo and task, and writes nothing when either is missing', async () => {
    const noRepo = await spawnWorker.handler({ task: 'do the thing' });
    expect(noRepo.isError).toBe(true);
    const noTask = await spawnWorker.handler({ repo: 'saber' });
    expect(noTask.isError).toBe(true);
    expect(text(noTask)).toContain('task is required');
    expect(outboundActions()).toHaveLength(0);
  });

  it('declares repo and task required, and takes no other way to say the same thing', async () => {
    // A `command` parameter would be a second way to express what `task`
    // already carries. The schema is the contract that keeps it to one.
    const schema = spawnWorker.tool.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required.sort()).toEqual(['repo', 'task']);
    expect(Object.keys(schema.properties).sort()).toEqual(['name', 'repo', 'task']);
  });
});

describe('defaultWorkerName', () => {
  it('names the worker after the repository, nested paths included', () => {
    expect(defaultWorkerName('saber')).toBe('saber-worker');
    expect(defaultWorkerName('wego/saber')).toBe('saber-worker');
  });
});

describe('spawn_worker — the request the host reads', () => {
  it('writes one spawn_worker system action carrying repo, task, name and its deadline', async () => {
    process.env.NANOCLAW_CREATE_WORKER_WAIT_MS = '1';
    const before = Date.now();

    await spawnWorker.handler({ repo: 'wego/saber', task: 'audit the gates' });

    const rows = outboundActions();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('system');
    expect(rows[0].content).toMatchObject({
      action: 'spawn_worker',
      repo: 'wego/saber',
      task: 'audit the gates',
      name: 'saber-worker',
    });
    expect(rows[0].content.requestId).toBe(rows[0].id);
    // waitUntil is how the host knows whether this call is still listening.
    expect(rows[0].content.waitUntil as number).toBeGreaterThanOrEqual(before);
  });

  it('does NOT use the create_agent action name', async () => {
    // `slack-agent-flow` registers over the `create_agent` delivery action and
    // matches on the action string to provision a Slack bot, a DM and a room.
    // A worker arriving under that name would come back as a Slack persona.
    process.env.NANOCLAW_CREATE_WORKER_WAIT_MS = '1';

    await spawnWorker.handler({ repo: 'saber', task: 'x' });

    expect(outboundActions()[0].content.action).toBe('spawn_worker');
  });

  it('passes a slash-command task through byte-for-byte', async () => {
    // A task beginning with '/' is dispatched as a real command in the
    // worker's session. Trimming aside, anything this tool adds to it —
    // a wrapper, a quote, a prefix — silently demotes it to prose.
    process.env.NANOCLAW_CREATE_WORKER_WAIT_MS = '1';

    await spawnWorker.handler({ repo: 'saber', task: '/blueprint FMTA-343' });

    expect(outboundActions()[0].content.task).toBe('/blueprint FMTA-343');
  });
});

describe('spawn_worker — the blocking round trip', () => {
  it('returns the host message once the worker exists and has been briefed', async () => {
    const pending = spawnWorker.handler({ repo: 'saber', task: 'audit the gates', name: 'Scout' });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const requestId = outboundActions()[0].content.requestId as string;
    seedWorkerResponse(requestId, 'created', {
      name: 'scout',
      repo: 'saber',
      message: 'Worker "scout" is standing in a worktree of "saber". Your task has been delivered to it.',
    });

    const r = await pending;
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('delivered to it');

    // The response row is acked so the poll loop won't re-deliver it.
    const acked = getOutboundDb()
      .prepare('SELECT status FROM processing_ack WHERE message_id = ?')
      .get(`worker-resp-${requestId}`) as { status: string } | null;
    expect(acked?.status).toBe('completed');
  });

  it('returns the reuse message rather than a second worker', async () => {
    const pending = spawnWorker.handler({ repo: 'saber', task: 'now run the gates' });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const requestId = outboundActions()[0].content.requestId as string;
    seedWorkerResponse(requestId, 'reused', {
      name: 'scout',
      repo: 'saber',
      message: 'Worker "scout" already works in "saber" for this conversation. Reused rather than duplicated.',
    });

    expect(text(await pending)).toContain('Reused rather than duplicated');
  });

  it('surfaces a host refusal as a tool error, naming the allowlist', async () => {
    const pending = spawnWorker.handler({ repo: 'no-such-repo', task: 'audit the gates' });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const requestId = outboundActions()[0].content.requestId as string;
    seedWorkerResponse(requestId, 'error', {
      error:
        'Cannot resolve repo "no-such-repo": no git repository by that name under any allowed root. Allowed roots: /srv/repos',
    });

    const r = await pending;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Allowed roots: /srv/repos');
  });

  it('degrades to "you will be woken" when the wait runs out — never to a failure', async () => {
    // Creation is still running. Reporting an error here would have the caller
    // tell the human about a failure that did not happen.
    process.env.NANOCLAW_CREATE_WORKER_WAIT_MS = '20';

    const r = await spawnWorker.handler({ repo: 'saber', task: 'audit the gates', name: 'Scout' });

    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('still being created');
    expect(text(r)).toContain('woken');
    expect(text(r)).toContain('rather than going silent');
  });
});
