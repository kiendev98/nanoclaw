import { createHash, randomUUID } from 'crypto';
import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../../config.js';
import { findSystemSession, taskThreadId, updateSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { TaskRecord } from '../../mailbox/index.js';
import { resolveTaskSession, withExistingMailboxSession, withMailboxSession } from '../../session-manager.js';
import { parseZonedToUtc } from '../../timezone.js';
import type { Session } from '../../types.js';
import { prepareTaskWorkspace } from './task-workspace.js';

export const MAX_DAILY_FIRES = 4;

const RECURRENCE_LIMIT_WARNING =
  'Warning: this task has not been scheduled. Frequent running tasks consume the ' +
  "user's subscription quota or unnecessarily use tokens and can cause the user's " +
  'account to be banned. Instead, use a pre-task run script that you write that can ' +
  'check some kind of external condition, usually via one or more API calls. The ' +
  'script returns a decision programmatically whether the task needs to be run now ' +
  'or not. For example, an API call to GitHub to check if there are open PRs, and ' +
  'only run when there are new open PRs.\n' +
  'Run `ncl tasks create --help` to get full directions on how to write a script and test it.\n\n' +
  'Note: if and only if you explicitly need to schedule a task more frequently and ' +
  "you've verified with the user that they understand and that this is what they " +
  'want and based on your judgment you agree that this is the right thing to do in ' +
  'this situation, you can override this with --dangerously-override-recurrence-limit';

export interface PreparedScheduledTask {
  name?: string;
  prompt: string;
  recurrence: string | null;
  script: string | null;
  processAfter: string;
  /** Repository name this series stands in, or null for the group folder. */
  repo: string | null;
}

export type ScheduledTaskRow = TaskRecord;

/**
 * The deterministic slug half of a task id. Exposed so template restamping can
 * find the live series a named task produced (`<slug>-<4hex>`).
 */
export function taskNameSlug(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
}

/**
 * Short, readable, filesystem/thread-safe task id. With a name → `<slug>-<4hex>`;
 * without one → `t-<6hex>`. Always matches /^[a-z0-9-]+$/ so it is safe as a
 * thread suffix, filename, and copy-pasteable CLI argument.
 */
export function makeTaskId(name: unknown): string {
  const hex = (n: number): string => randomUUID().replace(/-/g, '').slice(0, n);
  const slug = taskNameSlug(name);
  return slug ? `${slug}-${hex(4)}` : `t-${hex(6)}`;
}

export function parseProcessAfter(value: unknown, tz: string = TIMEZONE): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('--process-after is required');
  const date = parseZonedToUtc(value, tz);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid --process-after: ${value}`);
  return date.toISOString();
}

export function validateRecurrence(value: string | null | undefined, tz: string = TIMEZONE): void {
  if (!value) return;
  try {
    CronExpressionParser.parse(value, { tz });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid --recurrence: ${msg}`, { cause: err });
  }
}

export function enforceRecurrenceLimit(
  recurrence: string | null,
  override: boolean,
  hasScript: boolean,
  tz: string = TIMEZONE,
): void {
  // A gate script is the sanctioned mitigation: a skipped fire costs no agent
  // tokens, so scripted tasks may poll faster without the explicit override.
  if (!recurrence || override || hasScript) return;
  const horizon = Date.now() + 24 * 60 * 60 * 1000;
  const interval = CronExpressionParser.parse(recurrence, { tz });
  let fires = 0;
  while (fires <= MAX_DAILY_FIRES) {
    const next = interval.next();
    if (next.getTime() > horizon) break;
    fires++;
  }
  if (fires > MAX_DAILY_FIRES) throw new Error(RECURRENCE_LIMIT_WARNING);
}

/**
 * Validate task semantics and derive its first run without writing anything.
 * `timezone` grounds wall-clock interpretation (cron grid, naive
 * --process-after) — pass the owning group's effective timezone
 * (`resolveGroupTimezone`); it defaults to the install-global one.
 */
export function prepareScheduledTask(input: {
  name?: string;
  prompt: string;
  recurrence?: string | null;
  processAfter?: string;
  script?: string | null;
  dangerouslyOverrideRecurrenceLimit?: boolean;
  timezone?: string;
  repo?: string | null;
}): PreparedScheduledTask {
  if (!input.prompt) throw new Error('--prompt is required');
  const recurrence = input.recurrence ?? null;
  const script = input.script ?? null;
  const tz = input.timezone ?? TIMEZONE;
  validateRecurrence(recurrence, tz);
  enforceRecurrenceLimit(recurrence, input.dangerouslyOverrideRecurrenceLimit === true, script !== null, tz);

  let processAfter: string;
  if (input.processAfter === undefined && recurrence) {
    const next = CronExpressionParser.parse(recurrence, { tz }).next().toISOString();
    if (!next) throw new Error(`--recurrence has no upcoming run: ${recurrence}`);
    processAfter = next;
  } else {
    processAfter = parseProcessAfter(input.processAfter, tz);
  }

  return { name: input.name, prompt: input.prompt, recurrence, script, processAfter, repo: input.repo ?? null };
}

/**
 * The series id for one conversation's workspace.
 *
 * DERIVED, NEVER MINTED — this is what `makeTaskId` cannot be, because it
 * appends random hex. Identity has to be recomputable from the request alone,
 * or a repeated call cannot find the workspace it made last time and forks a
 * second branch instead. That is the divergence a repo-scoped agent's identity
 * has always existed to prevent.
 *
 * The pair is (repository, calling session), which is the same key the deleted
 * `spawn_worker` used. The repository slug is kept in front of the digest so a
 * stray worktree is still identifiable in `git branch` months later.
 *
 * A null repository is its own lane rather than an error: the run gets a
 * separate session in the group folder — its own container and transcript,
 * running alongside this conversation instead of inside it. `home-` names it,
 * and it cannot collide with a repository slug because the digest differs.
 *
 * Computed from the RAW `repo` string, before `resolveRepo` validates it — the
 * id has to exist so the lookup can tell whether a workspace already exists
 * for this pair, which is what decides whether validation even runs again.
 * That ordering is safe: the digest is only ever used as a lookup key, never
 * as proof of access, and `prepareTaskWorkspace` still resolves `repo` against
 * the operator allowlist before anything touches disk. The separator below is
 * what keeps an unvalidated string from being a problem regardless.
 */
export function workspaceSeriesId(repo: string | null, callerSessionId: string): string {
  // NUL, not a printable separator like '\n': `resolveRepo` hasn't run yet, so
  // `repo` is not yet known to exclude any particular character, but a POSIX
  // path segment can never contain NUL — the OS refuses to create one — so
  // (repo, session) still cannot be spelled two ways and hash to one id.
  const digest = createHash('sha256')
    .update(`${repo ?? ''}\0${callerSessionId}`)
    .digest('hex')
    .slice(0, 8);
  return `${(repo && taskNameSlug(repo)) || 'home'}-${digest}`;
}

/**
 * Find or create the workspace a run happens in.
 *
 * The "create" half of the two-step a caller sees; `queueRun` is the "run"
 * half. Everything the lookup needs is inside here rather than spread across
 * the caller, because find-or-create is the ONLY reason this is more than one
 * call — the CLI never does it, which is why `ncl tasks create` always mints a
 * new series and makes you read the id back before `ncl tasks run`.
 *
 * CREATED PAUSED, ALWAYS — but only at creation. The series row defines a
 * place; a caller that queues its own run must not also get a second run from
 * the row firing on its own schedule, so it is created paused and
 * `countDueMessages` (which requires `status = 'pending'`) can never see it
 * yet. That is a creation-time default, not an invariant this function
 * enforces on every call: `ncl tasks resume` (or `--recurrence` on an
 * existing series) can deliberately turn this series into a self-firing cron,
 * and doing so is operator intent this function must not override. It only
 * makes the consequence visible — see the warning below.
 *
 * Idempotent: safe to call repeatedly, and safe to retry after a crash. An
 * existing workspace has its worktree adopted or repaired rather than replaced.
 *
 * @param prefetched The session `findSystemSession` would return for this
 *   series, when the caller has already looked it up (`runTask` does, for its
 *   self-deadlock check) — passing it skips a second, identical query.
 *
 *   OPTIONAL ON PURPOSE, and it falls back to doing the lookup itself. This
 *   argument decides which branch runs, so a caller that omitted it while a
 *   series did exist would take the create path and stand a second series
 *   beside the first — a duplicate workspace, on a LOW-severity query saving.
 *   Correctness cannot rest on every future caller remembering to pass it.
 */
export async function ensureTaskSeries(
  agentGroupId: string,
  opts: { id: string; repo: string | null; prompt: string },
  prefetched?: Session | undefined,
): Promise<{ sessionId: string; created: boolean }> {
  const existing = prefetched ?? (await findSystemSession(agentGroupId, taskThreadId(opts.id)));
  if (existing) {
    // `ncl worktrees prune` removes a clean worktree without touching the row
    // that points at it, and a human can `rm -rf` one just as easily — so the
    // path is re-prepared on every run, not only at creation. With no
    // repository there is no worktree, and cwd stays the group folder.
    if (opts.repo) {
      const workspace = prepareTaskWorkspace(opts.repo, opts.id);
      if (!workspace.ok) throw new Error(workspace.error);
      await updateSession(existing.id, { workspace_path: workspace.path });
    }

    const series = await withExistingMailboxSession(agentGroupId, existing.id, (mailbox) => mailbox.getTask(opts.id));
    if (series && series.status !== 'paused') {
      log.warn('run_task is queuing into a series that is not paused — it may also fire on its own schedule', {
        seriesId: opts.id,
        status: series.status,
      });
    }

    return { sessionId: existing.id, created: false };
  }

  const prepared = prepareScheduledTask({
    name: opts.id,
    prompt: opts.prompt,
    // Required for a one-shot, and inert here: the row is paused, so this is
    // never a time anything fires at.
    processAfter: new Date().toISOString(),
    repo: opts.repo,
  });
  const { session } = await createScheduledTask(agentGroupId, prepared, { id: opts.id, status: 'paused' });
  return { sessionId: session.id, created: true };
}

/** Persist a prepared task through NanoClaw's single task/session representation. */
export async function createScheduledTask(
  agentGroupId: string,
  task: PreparedScheduledTask,
  options?: { status?: 'pending' | 'paused'; originSessionId?: string | null; id?: string },
): Promise<{ session: { id: string; agent_group_id: string }; row: ScheduledTaskRow }> {
  // A caller that DERIVES its series id supplies it, so the same request twice
  // converges on one series instead of minting a second one — which would mean
  // a second branch and a second worktree for one piece of work.
  const id = options?.id ?? makeTaskId(task.name);
  // Prepared BEFORE the session is resolved, so an unresolvable repository
  // aborts the create rather than leaving a scheduled task that fails at its
  // first fire, hours later, in a log nobody is reading.
  const workspace = task.repo ? prepareTaskWorkspace(task.repo, id) : null;
  if (workspace && !workspace.ok) throw new Error(workspace.error);
  const { session } = await resolveTaskSession(agentGroupId, id, workspace?.path ?? null);

  const row = await withMailboxSession(agentGroupId, session.id, async (db) => {
    await db.insertTask({
      id,
      seriesId: id,
      processAfter: task.processAfter,
      recurrence: task.recurrence,
      content: JSON.stringify({
        prompt: task.prompt,
        script: task.script,
        originSessionId: options?.originSessionId ?? null,
        repo: task.repo,
      }),
      status: options?.status ?? 'pending',
    });
    const stored = db.getTask(id);
    if (!stored) throw new Error(`task row not found after insert: ${id}`);
    return stored;
  });

  return { session: { id: session.id, agent_group_id: session.agent_group_id }, row };
}
