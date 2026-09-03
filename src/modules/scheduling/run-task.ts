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
import { randomUUID } from 'crypto';

import { parseBoundedRequest, respondAndWake, wakeRequester } from '../../bounded-request.js';
import { getSession, findSystemSession, taskThreadId, updateSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { withExistingMailboxSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { ensureTaskSeries, workspaceSeriesId } from './create.js';
import { parseTaskContent } from './task-content.js';

/** One caller waiting on a run, as stored on the task session. */
export interface PendingRunRequest {
  requesterSessionId: string;
  requestId: string;
  waitUntil: number | null;
  /**
   * The most recent interim turn's text, carried so the close-path backstop
   * can say something true when a run dies before its final turn.
   *
   * Kept on the waiter rather than in a new `sessions` column on purpose: this
   * is already a JSON blob the host owns, so it costs no migration, and the
   * text is only ever needed by the waiter it belongs to.
   */
  lastSummary?: string;
}

const RESPONSE_KIND = 'run-task';

interface RunTaskRequest {
  repo: string | null;
  instruction: string;
  requestId: string;
  waitUntil: number | null;
  /**
   * Stable id the calling tool mints once per call, independent of
   * `requestId` (which is absent for a fire-and-forget call). Used to derive
   * the occurrence row's id, so a delivery RETRY of this exact system message
   * — identical content, same runId — converges on the row it already queued
   * instead of minting a second one.
   */
  runId: string;
}

function parseRequest(content: Record<string, unknown>): RunTaskRequest {
  const str = (key: string): string => (typeof content[key] === 'string' ? (content[key] as string).trim() : '');
  const bounded = parseBoundedRequest(content);
  return {
    repo: str('repo') || null,
    instruction: str('instruction'),
    requestId: bounded.requestId,
    waitUntil: bounded.waitUntil,
    runId: str('runId'),
  };
}

/**
 * Tell the caller, through whichever door it left open.
 *
 * A FAILURE is exempt from the silence a missing `requestId` normally buys
 * (see `bounded-request.ts`'s table): the container tool already told the
 * agent "Queued in <repo>…" before this ever runs, so an error that reaches
 * nobody is worse than a wake nobody asked for. Success stays silent with no
 * `requestId` — nobody asked to be told the run merely started.
 */
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
  if (!ok && !req.requestId) await wakeRequester(session, message);
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
 * Keyed mutex serializing every read-modify-write of a task session's
 * `pending_run_request`, one per task session id.
 *
 * `queueRun` (append a waiter) and `answerPendingRunRequest` (pop one) both
 * read the column, compute a new array, and write it back — and they run from
 * independent call paths (a container's `run_task` call vs. a delivered
 * `task_log` row), so without this two in flight at once silently drop
 * whichever write lost the race. Per host process only, matching the same
 * precedent `session-manager.ts`'s `withSessionCreationLock` sets for session
 * creation — a second host process is not covered, and none exists here.
 */
const taskSessionLocks = new Map<string, Promise<void>>();

async function withTaskSessionLock<T>(taskSessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = taskSessionLocks.get(taskSessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  taskSessionLocks.set(taskSessionId, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (taskSessionLocks.get(taskSessionId) === tail) taskSessionLocks.delete(taskSessionId);
  }
}

/**
 * The "run" half: queue exactly one occurrence, and park the caller if it
 * asked to be told how the run went.
 *
 * The waiter is added BEFORE the occurrence. The sweep can arm a due task
 * within milliseconds, and a waiter registered afterwards would be recorded
 * against a run that had already reported.
 *
 * Both steps are idempotent under a RETRY of the exact same call (a delivery
 * retry re-running this system action with identical content): the occurrence
 * id is derived from `runId`, which the calling tool mints once and a retry
 * repeats, so a second attempt finds the row already there instead of mining
 * a second one; and the waiter list is deduped by `requestId` before a new
 * entry is appended.
 */
async function queueRun(
  taskSessionId: string,
  agentGroupId: string,
  seriesId: string,
  instruction: string,
  runId: string,
  waiter: PendingRunRequest | null,
): Promise<void> {
  if (waiter) {
    await withTaskSessionLock(taskSessionId, async () => {
      const session = await getSession(taskSessionId);
      const waiters = readWaiters(session?.pending_run_request);
      if (waiters.some((w) => w.requestId === waiter.requestId)) return;
      await updateSession(taskSessionId, { pending_run_request: JSON.stringify([...waiters, waiter]) });
    });
  }

  // Deterministic, not `makeTaskId` (which appends random hex on every call):
  // a retried delivery carries the same runId, so this has to land on the
  // SAME id both times, not a fresh one the second time around.
  const occurrenceId = `${seriesId}-run-${runId}`;

  await withExistingMailboxSession(agentGroupId, taskSessionId, (mailbox) => {
    if (mailbox.getTask(occurrenceId)) return; // already queued by an earlier attempt at this same call
    const series = mailbox.getTask(seriesId);
    const content = series ? parseTaskContent(series.content) : null;
    return mailbox.insertTask({
      id: occurrenceId,
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
    place = await ensureTaskSeries(
      session.agent_group_id,
      { id: seriesId, repo: req.repo, prompt: req.instruction },
      target,
    );
  } catch (err) {
    await respond(session, req, false, `run_task failed: ${err instanceof Error ? err.message : String(err)}`);
    log.warn('run_task could not prepare a workspace', { repo: req.repo, err });
    return;
  }

  // A missing runId (an unpatched container image, or a malformed payload)
  // degrades to the pre-fix behaviour — a fresh random id every call — rather
  // than failing the run outright; only a retried delivery needs it to match.
  const runId = req.runId || randomUUID();

  await queueRun(
    place.sessionId,
    session.agent_group_id,
    seriesId,
    req.instruction,
    runId,
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
  // Re-read inside the lock rather than trust the passed-in snapshot: a
  // concurrent `queueRun` on this same task session may have appended a
  // waiter after `taskSession` was loaded, and writing back a shift computed
  // from the stale list would silently erase that append.
  const next = await withTaskSessionLock(taskSession.id, async () => {
    const fresh = await getSession(taskSession.id);
    const waiters = readWaiters(fresh?.pending_run_request);
    if (waiters.length === 0) {
      if (fresh?.pending_run_request) await updateSession(taskSession.id, { pending_run_request: null });
      return null;
    }

    // Shifted and written back BEFORE the answer is sent. A second `task_log`
    // for one run — an explicit `ncl tasks append-log` after the automatic one —
    // must not answer the same caller twice, and a throw below must not leave
    // this waiter to consume the next run's result instead.
    const [head, ...rest] = waiters;
    await updateSession(taskSession.id, {
      pending_run_request: rest.length > 0 ? JSON.stringify(rest) : null,
    });
    return head;
  });

  if (!next) return;

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

/**
 * The requester's answer to a question its run asked.
 *
 * Resume needs no new machinery: `deliverQuestionResponse` is the same path a
 * button click takes, and the run is blocked polling its own inbox for exactly
 * this row, so it continues within a second of the write.
 *
 * THE GUARD IS THE POINT. Without it any agent that learned a questionId could
 * answer any run's question — including one belonging to a conversation it
 * cannot see. A caller may answer only a question asked by a run it is itself
 * waiting on, which the parked waiter proves.
 */
export async function answerTaskQuestion(content: Record<string, unknown>, session: Session): Promise<void> {
  const questionId = typeof content.questionId === 'string' ? content.questionId.trim() : '';
  const answer = typeof content.answer === 'string' ? content.answer.trim() : '';
  const req = parseBoundedRequest(content);
  const fail = async (message: string): Promise<void> => {
    await respondAndWake(session, req, {
      kind: 'answer-task-question',
      body: { type: 'answer_task_question_response', status: 'error', result: { error: message } },
      wakeText: message,
    });
    if (!req.requestId) await wakeRequester(session, message);
  };

  if (!questionId || !answer) {
    await fail('answer_task_question needs both questionId and answer.');
    return;
  }

  const { getPendingQuestion } = await import('../../db/sessions.js');
  const pending = await getPendingQuestion(questionId);
  if (!pending) {
    await fail(`No question "${questionId}" is waiting — it was already answered, or it timed out.`);
    return;
  }

  const taskSession = await getSession(pending.session_id);
  const owns = readWaiters(taskSession?.pending_run_request).some((w) => w.requesterSessionId === session.id);
  if (!owns) {
    await fail(`Question "${questionId}" belongs to a run you did not start.`);
    return;
  }

  const { deliverQuestionResponse } = await import('../interactive/index.js');
  const delivered = await deliverQuestionResponse(questionId, answer, '');
  if (!delivered) {
    await fail(`Could not deliver the answer to "${questionId}" — the run may have ended.`);
    return;
  }

  await respondAndWake(session, req, {
    kind: 'answer-task-question',
    body: { type: 'answer_task_question_response', status: 'completed', result: { questionId, answer } },
    wakeText: `Answered "${answer}". The run has resumed.`,
  });
}

/**
 * Hand a task run's question to whoever started the run.
 *
 * A task session is headless. Its question card is addressed from its own
 * routing, which is empty until it has posted something and bound a thread —
 * so before this, a question from a run that had not yet spoken was recorded
 * as pending, dropped by the routing check, answered by nobody, and timed out.
 * Even a bound run asks in a thread the human may not be watching.
 *
 * The waiter already names the session that asked for the work, and that
 * session is talking to a human right now. So the question goes there, and the
 * requester relays it, exactly as it relays the result.
 *
 * Deliberately NOT for fire-and-forget runs: with no waiter there is nobody to
 * ask, and this returns false so the caller falls back to the channel path.
 *
 * @returns true when the question was handed to a requester, meaning the
 *   caller must not also deliver the card to a channel.
 */
export async function relayQuestionToRequester(
  taskSession: Session,
  question: { questionId: string; title: string; question: string; options: Array<{ label: string; value: string }> },
): Promise<boolean> {
  const waiters = readWaiters(taskSession.pending_run_request);
  // FIFO head: the caller whose run this is. A second parked caller is waiting
  // on a later run and has no standing to answer this one's question.
  const target = waiters[0];
  if (!target) return false;

  const requester = await getSession(target.requesterSessionId);
  if (!requester) {
    log.warn('run_task question has no requester to relay to', { sessionId: target.requesterSessionId });
    return false;
  }

  const choices = question.options.map((o) => `"${o.value}"`).join(', ');
  const text =
    `The run you started is BLOCKED on a question and cannot continue until you answer.\n\n` +
    `${question.title}\n${question.question}\n\n` +
    `Options: ${choices}\n\n` +
    `Ask the human, then call answer_task_question({ questionId: "${question.questionId}", answer: "<their choice>" }) ` +
    `with one of those exact values. Do not answer on their behalf. ` +
    `The run times out if nothing arrives, and its work so far is lost.`;

  await writeSessionMessage(requester.agent_group_id, requester.id, {
    id: `taskq-${question.questionId}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  await requestWake(requester, 'task-question');
  log.info('Relayed a task question to its requester', {
    questionId: question.questionId,
    taskSessionId: taskSession.id,
    requesterSessionId: requester.id,
  });
  return true;
}

/**
 * Remember an interim turn's text on every parked waiter, without answering.
 *
 * A run that ends a turn with subagents still working is not finished, so no
 * waiter is released — but if it then dies (rate limit, kill, crash) there is
 * no final turn and nothing else would ever be said. This is what lets
 * `answerAbandonedRunRequests` report the last thing that was actually true.
 */
export async function recordInterimRunSummary(taskSession: Session, summary: string): Promise<void> {
  if (!summary) return;
  await withTaskSessionLock(taskSession.id, async () => {
    const fresh = await getSession(taskSession.id);
    const waiters = readWaiters(fresh?.pending_run_request);
    if (waiters.length === 0) return;
    const updated = waiters.map((w) => ({ ...w, lastSummary: summary }));
    await updateSession(taskSession.id, { pending_run_request: JSON.stringify(updated) });
  });
}

/**
 * Release every waiter still parked on a task session that is being closed.
 *
 * THE BACKSTOP, and it is what makes final-turn gating safe to ship. Gating
 * alone trades a premature answer for a permanent silence: a run killed
 * between an interim turn and its final one leaves a waiter nothing will ever
 * release, and the caller waits forever. A session only closes once it is
 * spent — no container, no live tasks — so at that point the run is over
 * however it ended, and whatever was last true is the honest answer.
 *
 * Drains the whole queue rather than one waiter: the run is not coming back,
 * so a second caller parked behind the first would never be answered either.
 */
export async function answerAbandonedRunRequests(taskSession: Session): Promise<void> {
  const waiters = await withTaskSessionLock(taskSession.id, async () => {
    const fresh = await getSession(taskSession.id);
    const parked = readWaiters(fresh?.pending_run_request);
    if (parked.length === 0) return [];
    await updateSession(taskSession.id, { pending_run_request: null });
    return parked;
  });

  for (const waiter of waiters) {
    const requester = await getSession(waiter.requesterSessionId);
    if (!requester) continue;
    const message = waiter.lastSummary
      ? `The run ended without a final result. The last thing it reported was: ${waiter.lastSummary}`
      : 'The run ended without reporting a result. Check its run log with `ncl tasks get <series>`.';
    await respondAndWake(
      requester,
      { requestId: waiter.requestId, waitUntil: waiter.waitUntil },
      {
        kind: RESPONSE_KIND,
        body: { type: 'run_task_response', status: 'error', result: { error: message } },
        wakeText: message,
      },
    );
  }
}
