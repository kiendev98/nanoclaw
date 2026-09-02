/**
 * `run_task` delivery-action body — the host half of the container's
 * `run_task` tool (container/agent-runner/src/mcp-tools/scheduling.ts).
 *
 * It queues one on-demand occurrence of an EXISTING task series, in a session
 * that is not the caller's. That is the whole feature: a task session can hold
 * a repository worktree, its own memory, and a Slack thread, so `run_task` is
 * how one session hands work to another process without becoming that process.
 *
 * THREE DELIVERY MODES, AND THE PAYLOAD DECIDES WHICH — see
 * `src/bounded-request.ts` for the table. `requestId` absent means nobody is
 * listening and nobody wants telling, so the run is fire-and-forget and this
 * writes no answer at all.
 *
 * THE RESULT COMES BACK FROM THE RUN, NOT FROM HERE. Queuing succeeds long
 * before the work does, so a caller answered here would be told "started" and
 * nothing else. Instead the waiter is parked on the TASK session's
 * `pending_run_request`, and `delivery.ts` answers it when that run's
 * `task_log` row arrives — which is the run's own final text. The column lives
 * on the session because a `task_log` row names the series, never the
 * occurrence that produced it.
 */
import { getSession, findSystemSession, taskThreadId, updateSession } from '../../db/sessions.js';
import { parseBoundedRequest, respondAndWake } from '../../bounded-request.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { makeTaskId } from './create.js';
import { parseTaskContent } from './task-content.js';
import { prepareTaskWorkspace } from './task-workspace.js';

/** Who is waiting on a task session's next run, as stored on that session. */
export interface PendingRunRequest {
  requesterSessionId: string;
  requestId: string;
  waitUntil: number | null;
}

const RESPONSE_KIND = 'run-task';

interface RunTaskRequest {
  series: string;
  requestId: string;
  waitUntil: number | null;
}

function parseRequest(content: Record<string, unknown>): RunTaskRequest {
  const bounded = parseBoundedRequest(content);
  return {
    series: typeof content.series === 'string' ? content.series.trim() : '',
    requestId: bounded.requestId,
    waitUntil: bounded.waitUntil,
  };
}

/** Tell the caller, through whichever door it left open. */
async function respond(session: Session, req: RunTaskRequest, ok: boolean, message: string): Promise<void> {
  await respondAndWake(
    session,
    { requestId: req.requestId, waitUntil: req.waitUntil },
    {
      kind: RESPONSE_KIND,
      body: {
        type: 'run_task_response',
        status: ok ? 'queued' : 'error',
        result: ok ? { message } : { error: message },
      },
      wakeText: message,
    },
  );
}

export async function runTask(content: Record<string, unknown>, session: Session): Promise<void> {
  const req = parseRequest(content);
  if (!req.series) {
    await respond(session, req, false, 'run_task failed: series is required.');
    return;
  }

  const target = await findSystemSession(session.agent_group_id, taskThreadId(req.series));
  if (!target) {
    await respond(
      session,
      req,
      false,
      `run_task failed: no task series "${req.series}" in this agent group. ` +
        'List them with `ncl tasks list`, or create one with `ncl tasks create`.',
    );
    return;
  }

  // Self-deadlock. Containers are keyed per session, so a session that queues
  // a run of ITSELF waits for a container that cannot start until this turn
  // ends — and with a bounded wait it would sit there doing nothing until the
  // deadline. Two DIFFERENT sessions are fine and are the point of the tool.
  if (target.id === session.id) {
    await respond(
      session,
      req,
      false,
      `run_task failed: "${req.series}" runs in this very session, so waiting for it would wait on yourself. ` +
        'Just do the work directly.',
    );
    return;
  }

  const queued = await withExistingMailboxSession(target.agent_group_id, target.id, (mailbox) => {
    const row = mailbox.findTaskBySeriesSlug(req.series) ?? mailbox.getTask(req.series);
    if (!row) return undefined;
    return { content: row.content, seriesId: row.seriesId ?? row.id };
  });
  if (!queued) {
    await respond(session, req, false, `run_task failed: task series "${req.series}" has no rows to run.`);
    return;
  }

  // Same repair as `ncl tasks run`: a worktree can go missing between fires
  // and the spawn reads the session row, not the derivation.
  const repo = parseTaskContent(queued.content).repo;
  if (repo) {
    const workspace = prepareTaskWorkspace(repo, queued.seriesId);
    if (!workspace.ok) {
      await respond(session, req, false, `run_task failed: ${workspace.error}`);
      return;
    }
    await updateSession(target.id, { workspace_path: workspace.path });
  }

  // Parked BEFORE the occurrence is inserted. The sweep can arm a due task
  // within milliseconds, and a waiter registered afterwards would be recorded
  // against a run that had already reported.
  if (req.requestId) {
    const pending: PendingRunRequest = {
      requesterSessionId: session.id,
      requestId: req.requestId,
      waitUntil: req.waitUntil,
    };
    await updateSession(target.id, { pending_run_request: JSON.stringify(pending) });
  }

  await withExistingMailboxSession(target.agent_group_id, target.id, (mailbox) =>
    mailbox.insertTask({
      id: makeTaskId(`${queued.seriesId}-run`),
      seriesId: queued.seriesId,
      processAfter: new Date().toISOString(),
      // recurrence=NULL is load-bearing: a run-now row must not be re-armed by
      // handleRecurrence into a phantom series.
      recurrence: null,
      content: queued.content,
    }),
  );

  log.info('run_task queued an occurrence', {
    series: queued.seriesId,
    requester: session.id,
    target: target.id,
    waiting: Boolean(req.requestId),
  });

  // Deliberately no answer on the success path when nobody asked for one, and
  // no "queued" answer when they did: the run's own `task_log` is the answer.
}

/**
 * Answer whoever is waiting on this task session's run, and clear the park.
 *
 * Called from the `task_log` branch of delivery, which is where the host
 * learns a run produced its final text.
 */
export async function answerPendingRunRequest(taskSession: Session, runSummary: string): Promise<void> {
  if (!taskSession.pending_run_request) return;

  let pending: PendingRunRequest;
  try {
    pending = JSON.parse(taskSession.pending_run_request) as PendingRunRequest;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a malformed park must not stop the run log
  } catch (err) {
    log.warn('Unreadable pending_run_request — clearing', { sessionId: taskSession.id, err });
    await updateSession(taskSession.id, { pending_run_request: null });
    return;
  }

  // Cleared FIRST. A second task_log for the same run — an explicit
  // `ncl tasks append-log` after the automatic one — must not answer twice,
  // and a throw below must not leave the park to answer the next run instead.
  await updateSession(taskSession.id, { pending_run_request: null });

  const requester = await getSession(pending.requesterSessionId);
  if (!requester) {
    log.warn('run_task requester is gone — dropping the answer', { sessionId: pending.requesterSessionId });
    return;
  }

  await respondAndWake(
    requester,
    { requestId: pending.requestId, waitUntil: pending.waitUntil },
    {
      kind: RESPONSE_KIND,
      body: { type: 'run_task_response', status: 'completed', result: { message: runSummary } },
      wakeText: runSummary,
    },
  );
}
