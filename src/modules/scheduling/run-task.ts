/**
 * `run_task` delivery-action body — the host half of the container's
 * `run_task` tool (container/agent-runner/src/mcp-tools/scheduling.ts).
 *
 * ONE CALL DOES EVERYTHING, which is the whole point and is what the deleted
 * `spawn_worker` also promised: resolve the repository, adopt or create the
 * workspace, and queue the run. The caller never shells out to `ncl tasks
 * create` first, and never has to read a generated id back before it can run
 * anything.
 *
 * IDENTITY IS DERIVED, NOT PASSED. A run belongs to the pair (repository,
 * calling session) — the same key `spawn_worker` used — so calling twice for
 * one repository in one conversation reuses the first workspace instead of
 * standing a second branch beside it. `workspaceSeriesId` recomputes that key
 * from the request alone, which is also what makes a retried or half-finished
 * call converge rather than fork.
 *
 * THE RESULT COMES FROM THE RUN, NOT FROM QUEUING. Queuing succeeds long
 * before the work does, so a caller answered here would be told "started" and
 * nothing else. Waiters park on the task session's `pending_run_request` and
 * are answered from `delivery.ts` when that run's `task_log` row arrives —
 * which carries the run's own final text. They park as a QUEUE because runs in
 * one session are serialized, so their `task_log` rows arrive in the same
 * order the waiters were added.
 */
import { parseBoundedRequest, respondAndWake } from '../../bounded-request.js';
import { getSession, findSystemSession, taskThreadId, updateSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { ensureTaskSeries, makeTaskId, workspaceSeriesId } from './create.js';
import { parseTaskContent } from './task-content.js';

/** One caller waiting on a run, as stored on the task session. */
export interface PendingRunRequest {
  requesterSessionId: string;
  requestId: string;
  waitUntil: number | null;
}

const RESPONSE_KIND = 'run-task';

interface RunTaskRequest {
  repo: string | null;
  instruction: string;
  requestId: string;
  waitUntil: number | null;
}

function parseRequest(content: Record<string, unknown>): RunTaskRequest {
  const str = (key: string): string => (typeof content[key] === 'string' ? (content[key] as string).trim() : '');
  const bounded = parseBoundedRequest(content);
  return {
    repo: str('repo') || null,
    instruction: str('instruction'),
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

function readWaiters(raw: string | null | undefined): PendingRunRequest[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingRunRequest[]) : [];
    // eslint-disable-next-line no-catch-all/no-catch-all -- a malformed park must never stop a run
  } catch {
    return [];
  }
}

/**
 * The "run" half: queue exactly one occurrence, and park the caller if it
 * asked to be told how the run went.
 *
 * The waiter is added BEFORE the occurrence. The sweep can arm a due task
 * within milliseconds, and a waiter registered afterwards would be recorded
 * against a run that had already reported.
 */
async function queueRun(
  taskSessionId: string,
  agentGroupId: string,
  seriesId: string,
  instruction: string,
  waiter: PendingRunRequest | null,
): Promise<void> {
  if (waiter) {
    const session = await getSession(taskSessionId);
    const waiters = [...readWaiters(session?.pending_run_request), waiter];
    await updateSession(taskSessionId, { pending_run_request: JSON.stringify(waiters) });
  }

  await withExistingMailboxSession(agentGroupId, taskSessionId, (mailbox) => {
    const series = mailbox.getTask(seriesId);
    const content = series ? parseTaskContent(series.content) : null;
    return mailbox.insertTask({
      id: makeTaskId(`${seriesId}-run`),
      seriesId,
      processAfter: new Date().toISOString(),
      // recurrence=NULL is load-bearing: a run-now row must not be re-armed by
      // handleRecurrence into a phantom series.
      recurrence: null,
      // The instruction travels per run; the series row only describes the
      // place. Everything else is inherited so the run keeps the workspace's
      // repository and any gate script the place carries.
      content: JSON.stringify({ ...(content ?? {}), prompt: instruction }),
    });
  });
}

export async function runTask(content: Record<string, unknown>, session: Session): Promise<void> {
  const req = parseRequest(content);
  if (!req.instruction) {
    await respond(session, req, false, 'run_task failed: instruction is required.');
    return;
  }

  const seriesId = workspaceSeriesId(req.repo, session.id);

  // Self-deadlock. Containers are keyed per session, so a session queuing a run
  // that lands on ITSELF would wait for a container that cannot start until
  // this turn ends. Only reachable when a task session names its own workspace.
  const target = await findSystemSession(session.agent_group_id, taskThreadId(seriesId));
  if (target?.id === session.id) {
    await respond(
      session,
      req,
      false,
      'run_task failed: that workspace is the one this session already runs in. Just do the work directly.',
    );
    return;
  }

  let place: { sessionId: string; created: boolean };
  try {
    place = await ensureTaskSeries(session.agent_group_id, {
      id: seriesId,
      repo: req.repo,
      prompt: req.instruction,
    });
  } catch (err) {
    await respond(session, req, false, `run_task failed: ${err instanceof Error ? err.message : String(err)}`);
    log.warn('run_task could not prepare a workspace', { repo: req.repo, err });
    return;
  }

  await queueRun(
    place.sessionId,
    session.agent_group_id,
    seriesId,
    req.instruction,
    req.requestId ? { requesterSessionId: session.id, requestId: req.requestId, waitUntil: req.waitUntil } : null,
  );

  log.info('run_task queued a run', {
    repo: req.repo,
    series: seriesId,
    requester: session.id,
    createdWorkspace: place.created,
    waiting: Boolean(req.requestId),
  });

  // Deliberately silent on success: with no requestId nobody asked for an
  // answer, and with one the run's own `task_log` is the answer.
}

/**
 * Answer the caller at the head of this task session's waiter queue.
 *
 * Called from the `task_log` branch of delivery, which is where the host
 * learns a run produced its final text. One waiter is released per run,
 * FIFO — runs in a session are serialized, so the queues line up.
 */
export async function answerPendingRunRequest(taskSession: Session, runSummary: string): Promise<void> {
  const waiters = readWaiters(taskSession.pending_run_request);
  if (waiters.length === 0) {
    if (taskSession.pending_run_request) {
      await updateSession(taskSession.id, { pending_run_request: null });
    }
    return;
  }

  // Shifted and written back BEFORE the answer is sent. A second `task_log`
  // for one run — an explicit `ncl tasks append-log` after the automatic one —
  // must not answer the same caller twice, and a throw below must not leave
  // this waiter to consume the next run's result instead.
  const [next, ...rest] = waiters;
  await updateSession(taskSession.id, {
    pending_run_request: rest.length > 0 ? JSON.stringify(rest) : null,
  });

  const requester = await getSession(next.requesterSessionId);
  if (!requester) {
    log.warn('run_task requester is gone — dropping the answer', { sessionId: next.requesterSessionId });
    return;
  }

  await respondAndWake(
    requester,
    { requestId: next.requestId, waitUntil: next.waitUntil },
    {
      kind: RESPONSE_KIND,
      body: { type: 'run_task_response', status: 'completed', result: { message: runSummary } },
      wakeText: runSummary,
    },
  );
}
