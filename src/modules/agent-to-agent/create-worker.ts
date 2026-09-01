/**
 * `create_worker` delivery-action bodies — the host half of the container's
 * blocking `create_worker` tool (container/agent-runner/src/mcp-tools/workers.ts).
 *
 * ONE CALL DOES EVERYTHING. Resolving the repository, creating or reusing the
 * worktree and the agent group, wiring both destination rows, and DELIVERING
 * the brief all happen here, and the requester is answered inline. The tool it
 * answers is blocking, so the caller never has to be woken merely to learn
 * that its delegate exists and then send it a message in a second turn.
 *
 * SECURITY: creating a worker never requires admin approval (guard's
 * `workers.create` decision, ./guard.ts, ALLOWs unconditionally for any agent
 * actor). The containment is the operator allowlist below, not a decision —
 * see `repo`.
 *
 * `repo` raises the stakes rather than adding a feature: it decides the
 * worker's WORKING directory, and cwd is the only thing that decides which
 * repository's `CLAUDE.md`, `.claude/skills/` and `.claude/settings.json` that
 * worker loads. It arrives from the untrusted container, so it is never
 * treated as a path — it is a NAME resolved against the operator's
 * `NANOCLAW_PROJECT_ROOTS` allowlist (empty by default), and an unresolvable
 * name aborts loudly. It must never fall back to the group folder: a worker in
 * the wrong repository is indistinguishable from a working one until it edits
 * the wrong tree.
 *
 * A worker is the pair (repository, originating thread), NOT one per command.
 * A second `create_worker` for the same repo in the same thread returns the
 * FIRST worker and delivers the new task to it; see `worker-identity.ts` for
 * why the branch derives from the origin session.
 *
 * NOTHING HERE EVER BLOCKS ON A HUMAN. There is no approval step left to
 * block on, but the tool's own wait is still bounded: a worktree checkout on a
 * large repository can outrun the tool's 60s poll. Every late outcome — the
 * checkout finishing after the caller gave up — is written to the response
 * row AND wakes the requester, because a row nobody is polling any more is
 * silence. `waitUntil`, which the tool stamps from its own deadline, is what
 * separates "still polling" from "already gave up".
 */
import { PROJECT_ROOTS } from '../../config.js';
import { findWorkerForOrigin, getAgentGroup, updateAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { GuardDenyError } from '../../guard/index.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import { createWorktree, resolveRepo } from '../../worktree.js';
import { routeAgentMessage } from './agent-route.js';
import { getDestinationByTarget } from './db/agent-destinations.js';
import { provisionAgentGroup } from './provision-agent.js';
import { workerBranch, workerWorkspace } from './worker-identity.js';

/** How the request ended, as the container tool reads it. */
type WorkerStatus = 'created' | 'reused' | 'error';

/**
 * Grace on `waitUntil`. Inside the window the tool is still polling and the
 * response row alone reaches it; within this margin of the deadline the race
 * is unwinnable either way, so the requester is woken too. A duplicate wake
 * costs one turn; the other error costs the whole delegation, silently.
 */
const LATE_MARGIN_MS = 5_000;

interface WorkerRequest {
  requestId: string;
  repo: string;
  task: string;
  name: string;
  waitUntil: number | null;
}

/** The container's payload, re-read on every entry. */
function parseRequest(content: Record<string, unknown>): WorkerRequest {
  const str = (key: string): string => (typeof content[key] === 'string' ? (content[key] as string).trim() : '');
  return {
    requestId: str('requestId'),
    repo: str('repo'),
    task: str('task'),
    name: str('name'),
    waitUntil: typeof content.waitUntil === 'number' ? content.waitUntil : null,
  };
}

/** Is the tool that asked still listening, or has its bounded wait run out? */
function callerStoppedWaiting(req: WorkerRequest): boolean {
  // An absent deadline means the payload did not come from the tool (a
  // hand-written row, an older container). Treat it as no longer waiting:
  // an extra wake is recoverable, a lost answer is not.
  if (req.waitUntil === null) return true;
  return Date.now() > req.waitUntil - LATE_MARGIN_MS;
}

/**
 * Answer the blocking tool, and wake the requester when the tool has already
 * given up.
 *
 * The response row is `kind: 'system'` and non-triggering, exactly like
 * `canvas_read`'s: the tool polls for it by `requestId`, and the poll loop
 * filters system rows out of agent prompts, so it can never read as an
 * unanswered wake.
 */
async function respond(session: Session, req: WorkerRequest, status: WorkerStatus, message: string): Promise<void> {
  if (req.requestId) {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `worker-resp-${req.requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({
        type: 'create_worker_response',
        requestId: req.requestId,
        status,
        result: status === 'error' ? { error: message } : { name: req.name, repo: req.repo, message },
      }),
      trigger: false,
    });
  }
  if (callerStoppedWaiting(req)) await notifyAgent(session, message);
}

/** A renderable chat note that wakes the requester — the late-answer path. */
async function notifyAgent(session: Session, text: string): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = await getSession(session.id);
  if (fresh) await requestWake(fresh, 'agent-created');
}

/**
 * The worker this (repo, thread) pair already has, or undefined.
 *
 * The key is `(origin_session_id, workspace_path)`, and it is a genuine pair
 * rather than a redundant one: `workspace_path` is a pure function of (repo,
 * origin session), so one thread can hold one worker per repository, while the
 * same repository in another thread is a different worker.
 */
async function existingWorkerFor(repoPath: string, originSessionId: string): Promise<AgentGroup | undefined> {
  return findWorkerForOrigin(originSessionId, workerWorkspace(repoPath, originSessionId));
}

/**
 * Put a reused worker's worktree back if it is gone, and keep the row honest.
 *
 * `createWorktree` is idempotent on its path, so the healthy case costs one
 * `existsSync`. The row is re-stamped when the derived path has moved, because
 * `workspace_path` — not the derivation — is what
 * `composeSessionSpec` turns into the worker's cwd. Re-deriving without
 * re-stamping would create the right directory and still spawn into the old
 * one.
 *
 * @returns ok, or the agent-facing reason the workspace could not be restored.
 *   Never throws: the caller answers a blocking tool, and an unhandled throw
 *   there is a delegation that dies silently.
 */
async function ensureWorktree(
  worker: AgentGroup,
  repoPath: string,
  originSessionId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const target = createWorktree(repoPath, workerBranch(originSessionId));
    if (target !== worker.workspace_path) {
      await updateAgentGroup(worker.id, { workspace_path: target });
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        `Worker "${worker.name}" exists but its worktree could not be restored: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The requester's handle for an existing worker.
 *
 * The local name matters more than the group id: it is the only handle
 * `send_message` accepts. A worker with no destination row in the requester's
 * namespace is unreachable, so that case falls through to a fresh creation
 * rather than handing back a name that does not resolve.
 */
async function reusableWorkerName(sourceGroupId: string, worker: AgentGroup): Promise<string | undefined> {
  return (await getDestinationByTarget(sourceGroupId, 'agent', worker.id))?.local_name;
}

/**
 * Deliver the brief to the worker, on the orchestrator's behalf.
 *
 * Routed through `routeAgentMessage` rather than written straight into the
 * worker's mailbox: the brief is agent-authored content crossing an
 * agent-to-agent edge, and that edge has exactly one door — the `a2a.send`
 * guard, where an operator's `agent_message_policies` row can still card an
 * admin. Bypassing it here would be a second, unguarded door for the same
 * content.
 */
async function deliverBrief(
  session: Session,
  workerGroupId: string,
  task: string,
): Promise<'delivered' | 'held' | { error: string }> {
  try {
    return await routeAgentMessage(
      {
        id: `brief-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        platform_id: workerGroupId,
        content: JSON.stringify({ text: task }),
        in_reply_to: null,
      },
      session,
    );
  } catch (err) {
    if (err instanceof GuardDenyError) return { error: err.message };
    throw err;
  }
}

/** How a successful create/reuse reads once the brief's fate is known. */
function briefedText(
  localName: string,
  repo: string,
  reused: boolean,
  delivery: 'delivered' | 'held' | { error: string },
): string {
  const opening = reused
    ? `Worker "${localName}" already works in "${repo}" for this conversation. Reused rather than duplicated: ` +
      `a second worker would stand on a second branch and could not see the work "${localName}" has already done.`
    : `Worker "${localName}" is standing in a worktree of "${repo}".`;

  if (delivery === 'delivered') {
    return (
      `${opening} Your task has been delivered to it. ` +
      `Its ANSWER will arrive later as a message that wakes you — end your turn now. ` +
      `To add to the brief, send_message({ to: "${localName}", ... }).`
    );
  }
  if (delivery === 'held') {
    return (
      `${opening} Your task has NOT been delivered yet — a message policy holds messages from you to it for ` +
      `admin approval, and the card is now waiting. Tell the human you are waiting rather than going silent.`
    );
  }
  return (
    `${opening} Your task could NOT be delivered to it: ${delivery.error}. ` +
    `Tell the human — the worker exists but has no brief.`
  );
}

/**
 * Guard precheck: malformed requests are answered directly, and a reuse is
 * served here in full, before the guard is even consulted.
 *
 * Both resolution and reuse run BEFORE the guard for the same reason: an
 * unresolvable repo is a request that cannot succeed, and a reuse needs no new
 * privilege — the worker, its worktree and its destination row all exist
 * already. Running the (always-allow) guard for either would be wasted work,
 * not a safety gap.
 */
export async function validateCreateWorker(content: Record<string, unknown>, session: Session): Promise<boolean> {
  const req = parseRequest(content);
  if (!req.repo) {
    await respond(session, req, 'error', 'create_worker failed: repo is required.');
    return false;
  }
  if (!req.task) {
    await respond(session, req, 'error', 'create_worker failed: task is required.');
    return false;
  }
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!sourceGroup) {
    await respond(session, req, 'error', 'create_worker failed: source agent group not found.');
    log.warn('create_worker failed: missing source group', { sessionAgentGroup: session.agent_group_id, ...req });
    return false;
  }

  // Failure is loud and terminal: there is no fallback to the group folder,
  // because a worker silently created in the wrong directory looks exactly
  // like one created in the right one.
  let repoPath: string;
  try {
    repoPath = resolveRepo(req.repo, PROJECT_ROOTS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await respond(session, req, 'error', message);
    log.warn('create_worker failed: repo not resolvable', { repo: req.repo, err });
    return false;
  }

  const existing = await existingWorkerFor(repoPath, session.id);
  if (existing) {
    const localName = await reusableWorkerName(session.agent_group_id, existing);
    if (localName) {
      // The agent group outlives its directory. `ncl worktrees prune` removes a
      // clean worktree without touching `agent_groups`, and a human can `rm -rf`
      // one just as easily — so reuse must re-create it, or the brief is
      // delivered and the spawn then chdirs into a path that is not there.
      // Deliberately NOT fixed by clearing `workspace_path` on prune: the reuse
      // lookup keys on that column, so clearing it mints a SECOND worker on a
      // second branch for one thread, which is the duplicate this whole
      // (repo, thread) identity exists to prevent.
      const restored = await ensureWorktree(existing, repoPath, session.id);
      if (!restored.ok) {
        await respond(session, req, 'error', restored.error);
        log.warn('create_worker could not restore a reused worker workspace', {
          repo: req.repo,
          worker: existing.id,
          err: restored.error,
        });
        return false;
      }
      const delivery = await deliverBrief(session, existing.id, req.task);
      await respond(session, req, 'reused', briefedText(localName, req.repo, true, delivery));
      log.info('create_worker reused an existing worker', {
        repo: req.repo,
        localName,
        worker: existing.id,
        originSession: session.id,
      });
      return false;
    }
    // The worker exists but this requester cannot address it. Falling through
    // creates a reachable one rather than naming a handle that does not
    // resolve.
    log.warn('create_worker: worker exists for this thread but the requester has no destination for it', {
      repo: req.repo,
      worker: existing.id,
      originSession: session.id,
    });
  }
  return true;
}

/** Guard deny body: tell the requester, through the same channel it is waiting on. */
export async function denyCreateWorker(
  content: Record<string, unknown>,
  session: Session,
  reason: string,
): Promise<void> {
  await respond(session, parseRequest(content), 'error', `create_worker denied: ${reason}`);
}

/** Guard allow body: creates the worker and briefs it. */
export async function createWorker(content: Record<string, unknown>, session: Session): Promise<void> {
  const req = parseRequest(content);
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!req.repo || !req.task || !sourceGroup) return; // precheck already answered the requester

  // Resolved AGAIN here, and reuse re-checked, in case a concurrent
  // create_worker call for the same (repo, thread) already created a worker
  // between the precheck's lookup and this one. Creating anyway would put two
  // agents on two branches of one repository in one conversation, which is
  // the exact failure the (repo, thread) key exists to prevent.
  let repoPath: string;
  try {
    repoPath = resolveRepo(req.repo, PROJECT_ROOTS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await respond(session, req, 'error', message);
    log.error('create_worker failed: repo no longer resolvable', { repo: req.repo, err });
    return;
  }

  const existing = await existingWorkerFor(repoPath, session.id);
  const reuseName = existing && (await reusableWorkerName(sourceGroup.id, existing));
  if (existing && reuseName) {
    const delivery = await deliverBrief(session, existing.id, req.task);
    await respond(session, req, 'reused', briefedText(reuseName, req.repo, true, delivery));
    log.info('create_worker reused an existing worker', {
      repo: req.repo,
      localName: reuseName,
      worker: existing.id,
      originSession: session.id,
    });
    return;
  }

  // The worktree becomes the worker's cwd, which is the ONLY thing that makes
  // it load that repository's CLAUDE.md, `.claude/skills/` and
  // `.claude/settings.json`. Any failure aborts: a fallback to the group
  // folder produces a worker that answers confidently from the wrong
  // directory.
  //
  // The branch derives from the ORIGIN SESSION, not from the worker's folder:
  // it is the (repo, thread) pair that owns a branch, and a folder-derived
  // branch is what let a second worker exist beside the first.
  // `createWorktree` is idempotent on the resulting path, so a retry adopts
  // the worktree rather than duplicating it.
  let workspacePath: string;
  try {
    workspacePath = createWorktree(repoPath, workerBranch(session.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await respond(session, req, 'error', `Cannot create a worker for "${req.repo}": ${message}`);
    log.error('create_worker failed: could not prepare the repo worktree', { repo: req.repo, err });
    return;
  }

  const outcome = await provisionAgentGroup({
    name: req.name,
    instructions: null,
    sourceGroup,
    session,
    workspacePath,
  });
  if (!outcome.ok) {
    await respond(session, req, 'error', `Cannot create a worker for "${req.repo}": ${outcome.error}`);
    return;
  }

  const delivery = await deliverBrief(session, outcome.agentGroupId, req.task);
  await respond(session, req, 'created', briefedText(outcome.localName, req.repo, false, delivery));
  log.info('Worker created and briefed', {
    localName: outcome.localName,
    worker: outcome.agentGroupId,
    repo: req.repo,
    workspacePath,
    originSession: session.id,
    delivery: typeof delivery === 'string' ? delivery : 'denied',
  });
}
