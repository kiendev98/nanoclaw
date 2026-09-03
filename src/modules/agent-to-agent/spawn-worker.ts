/**
 * `spawn_worker` delivery-action bodies — the host half of the container's
 * blocking `spawn_worker` tool (container/agent-runner/src/mcp-tools/workers.ts).
 *
 * ONE CALL DOES EVERYTHING. Resolving the repository, creating or reusing the
 * worktree and the agent group, wiring both destination rows, and DELIVERING
 * the brief all happen here, and the requester is answered inline. The tool it
 * answers is blocking, so the caller never has to be woken merely to learn
 * that its delegate exists and then send it a message in a second turn.
 *
 * SECURITY: creating a worker never requires admin approval (guard's
 * `workers.spawn` decision, ./guard.ts, ALLOWs unconditionally for any agent
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
 * A second `spawn_worker` for the same repo in the same thread returns the
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
import { getSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import { getSessionDriver } from '../../drivers/index.js';
import { requestWake } from '../../request-wake.js';
import { GuardDenyError } from '../../guard/index.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import { createWorktree, resolveRepo } from '../../worktree.js';
import { routeAgentMessage } from './agent-route.js';
import { respondToBlockingTool } from './blocking-request.js';
import {
  createDestination,
  getDestinationByName,
  getDestinationByTarget,
  getDestinations,
  normalizeName,
} from './db/agent-destinations.js';
import { provisionAgentGroup } from './provision-agent.js';
import { writeDestinations } from './write-destinations.js';
import { workerBranch, workerWorkspace } from './worker-identity.js';

/** How the request ended, as the container tool reads it. */
type WorkerStatus = 'created' | 'reused' | 'error';

interface WorkerRequest {
  requestId: string;
  repo: string;
  task: string;
  name: string;
  /** Channel destinations the caller is lending the worker, by ITS OWN names. */
  channels: string[];
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
    channels: Array.isArray(content.channels)
      ? content.channels.filter((c): c is string => typeof c === 'string' && c.trim() !== '').map((c) => c.trim())
      : [],
    waitUntil: typeof content.waitUntil === 'number' ? content.waitUntil : null,
  };
}

/**
 * The caller's channel destinations, by the names it knows them as.
 *
 * Used only to write a refusal a caller can act on. A worker request names a
 * channel the same way `send_message` does, so an unknown name is the ordinary
 * typo and the useful answer lists what WOULD have worked — the same shape as
 * `resolveRepo`'s refusal, and for the same reason: the caller is an agent
 * that cannot list its own grants any other way.
 */
async function channelNames(agentGroupId: string): Promise<string[]> {
  return (await getDestinations(agentGroupId)).filter((d) => d.target_type === 'channel').map((d) => d.local_name);
}

/**
 * ATTENUATED DELEGATION: you cannot lend what you do not hold.
 *
 * One lookup per requested name is the entire security model for a worker on
 * a channel, and it is the right one. A worker runs code from ANOTHER
 * repository — its own CLAUDE.md, its own skills, its own settings — so its
 * instructions must never be able to widen its own reach. Every channel it can
 * post to is one the orchestrator could already post to, copied across
 * deliberately at spawn time.
 *
 * ALL OR NOTHING. A partial grant would hand back a worker that looks
 * provisioned and then fails at its first post, which for a review workflow
 * means the human never hears anything and nobody can see why.
 *
 * @returns undefined when every name checks out, or the agent-facing refusal.
 */
async function refuseUngrantableChannels(sourceGroupId: string, channels: string[]): Promise<string | undefined> {
  for (const name of channels) {
    const dest = await getDestinationByName(sourceGroupId, normalizeName(name));
    if (!dest || dest.target_type !== 'channel') {
      const known = await channelNames(sourceGroupId);
      return (
        `you have no channel destination named "${name}", and you cannot give a worker access you do not ` +
        `have yourself. Channels you can lend: ${known.length ? known.join(', ') : '(none)'}.`
      );
    }
  }
  return undefined;
}

/**
 * Copy the caller's channel rows onto the worker.
 *
 * Idempotent per name, because the reuse path runs this too: a second
 * `spawn_worker` for the same (repo, thread) may name a channel the first did
 * not, and the worker should gain it rather than silently keep the old set.
 *
 * The projection at the end is what a reused worker needs and a new one does
 * not. `spawnContainer` writes the destination map on every wake, so a worker
 * created here reads its grants when it starts; one that is ALREADY RUNNING
 * holds a map from its last wake, and without this its container answers
 * "unknown destination" for a channel the central DB says it holds.
 */
async function grantChannels(
  sourceGroupId: string,
  workerGroupId: string,
  channels: string[],
): Promise<{ added: string[]; refusal?: string }> {
  const now = new Date().toISOString();
  const added: string[] = [];
  for (const name of channels) {
    const local = normalizeName(name);
    const source = await getDestinationByName(sourceGroupId, local);
    // Re-read rather than trusting the precheck: this runs after the worktree
    // checkout, and a destination revoked in between must not be granted.
    //
    // REFUSING, NOT SKIPPING. This used to `continue`, which reported success
    // for a grant that did not happen — the ALL OR NOTHING contract above,
    // broken by the code meant to honour it.
    if (!source || source.target_type !== 'channel') {
      return { added, refusal: `"${name}" is no longer a channel you can lend, so nothing was granted.` };
    }

    const held = await getDestinationByName(workerGroupId, local);
    if (held) {
      // Idempotent only when it is genuinely the same grant. The name-only
      // check this replaces was a wrong-recipient bug waiting to happen:
      // `provisionAgentGroup` gives every worker AGENT destinations called
      // `parent` and `<localName>`, so lending a channel whose normalized name
      // collided with one of those silently did nothing, and the worker's
      // `resolveRouting` then resolved that name down the agent lane — posting
      // to its orchestrator instead of to the channel, with no error anywhere.
      if (held.target_type === 'channel' && held.target_id === source.target_id) continue;
      return {
        added,
        refusal:
          `"${name}" already names ${held.target_type === 'channel' ? 'a different channel' : 'an agent'} for ` +
          `this worker, so nothing was granted. Rename the destination you are lending, or lend a different one.`,
      };
    }

    await createDestination({
      agent_group_id: workerGroupId,
      local_name: local,
      target_type: 'channel',
      target_id: source.target_id,
      created_at: now,
    });
    added.push(local);
  }
  if (added.length > 0) {
    // Skip the CLOSED ones, rather than keeping only the active ones. The
    // column is `TEXT DEFAULT 'active'` with no NOT NULL, so a row can carry
    // null, and the two readings differ exactly there. Getting it wrong in the
    // strict direction would silently skip a live session and reinstate the
    // "unknown destination" failure this projection exists to prevent; getting
    // it wrong in this direction costs one mailbox write against a session
    // nobody reads. Only the second is recoverable, so bias to it.
    for (const session of await getSessionsByAgentGroup(workerGroupId)) {
      if (session.status === 'closed') continue;
      await writeDestinations(workerGroupId, session.id);
    }
    log.info('Channel destinations lent to worker', { worker: workerGroupId, from: sourceGroupId, channels: added });
  }
  return { added };
}

/**
 * Answer the blocking tool. The envelope is shared (blocking-request.ts); what
 * is local here is the `type` and the `result`, which are this tool's contract.
 */
async function respond(session: Session, req: WorkerRequest, status: WorkerStatus, message: string): Promise<void> {
  await respondToBlockingTool(
    session,
    req,
    {
      id: `worker-resp-${req.requestId}`,
      type: 'spawn_worker_response',
      status,
      result: status === 'error' ? { error: message } : { name: req.name, repo: req.repo, message },
    },
    message,
  );
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
export async function validateSpawnWorker(content: Record<string, unknown>, session: Session): Promise<boolean> {
  const req = parseRequest(content);
  if (!req.repo) {
    await respond(session, req, 'error', 'spawn_worker failed: repo is required.');
    return false;
  }
  if (!req.task) {
    await respond(session, req, 'error', 'spawn_worker failed: task is required.');
    return false;
  }
  // A worker's whole mechanism is a host git worktree under `WORKTREES_DIR`,
  // handed to the session as its cwd. Nothing mounts that path into a
  // container, and nothing can cheaply: a worktree's `.git` is a pointer file
  // into the parent repository, so the parent has to come too.
  //
  // Refused here rather than left to fail, because the failure has no shape an
  // operator can read. The spawn gets a cwd that does not exist inside the
  // container, dies at the first query, and the undelivered brief keeps it
  // respawning every 2 seconds — the same silent loop `#reportMissingRunnerDeps`
  // exists to explain.
  const driver = getSessionDriver().kind;
  if (driver !== 'local') {
    await respond(
      session,
      req,
      'error',
      `spawn_worker failed: repo workers need the local runtime driver, and this install runs '${driver}'. ` +
        'A worker stands in a host git worktree that is not mounted into a container.',
    );
    log.warn('spawn_worker refused: driver cannot reach a host worktree', { driver, repo: req.repo });
    return false;
  }
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!sourceGroup) {
    await respond(session, req, 'error', 'spawn_worker failed: source agent group not found.');
    log.warn('spawn_worker failed: missing source group', { sessionAgentGroup: session.agent_group_id, ...req });
    return false;
  }

  // Refused here, before the worktree checkout and before any central-DB
  // write, because a refusal after provisioning would leave a worker standing
  // in a repository with a brief it cannot carry out.
  const ungrantable = await refuseUngrantableChannels(sourceGroup.id, req.channels);
  if (ungrantable) {
    await respond(session, req, 'error', `spawn_worker failed: ${ungrantable}`);
    log.warn('spawn_worker refused: channel not held by the requester', {
      sourceGroup: sourceGroup.id,
      channels: req.channels,
    });
    return false;
  }

  // ONE LEVEL OF DELEGATION. A worker may not spawn a worker.
  //
  // The bound on an escalated question makes depth 2 structurally unanswerable
  // rather than merely slow. A sub-worker asks its parent and waits 600s; if
  // the parent must ask ITS orchestrator, that hop is also 600s and it starts
  // later — so the sub-worker's wait always expires first, every time, and the
  // answer arrives for nobody. Both agents then report being blocked on a
  // question that was in fact being answered.
  //
  // A shorter inner bound cannot fix it, because neither side can see how deep
  // the chain is: a worker knows only that its own address is an agent lane,
  // not whether the agent on the other end has a human behind it. Lifting this
  // means carrying a hop count on the lane and deriving the bound from it, and
  // that is worth building when a real depth-2 case turns up rather than now.
  //
  // `origin_session_id` is the marker, and it is set only by this action.
  if (sourceGroup.origin_session_id) {
    await respond(
      session,
      req,
      'error',
      `spawn_worker failed: "${sourceGroup.name}" is itself a worker, and a worker cannot spawn one. ` +
        'Do the work in your own worktree, or report back to your orchestrator that it needs a second ' +
        'worker for this — it can spawn one beside you.',
    );
    log.warn('spawn_worker refused: nested worker', { sourceGroup: sourceGroup.id, repo: req.repo });
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
    log.warn('spawn_worker failed: repo not resolvable', { repo: req.repo, err });
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
        log.warn('spawn_worker could not restore a reused worker workspace', {
          repo: req.repo,
          worker: existing.id,
          err: restored.error,
        });
        return false;
      }
      // Lent BEFORE the brief, so the worker's very first turn already holds
      // the channel its task tells it to use. This is the reuse path that
      // actually fires — the branch in `spawnWorker` below only catches a
      // worker created concurrently between that lookup and this one.
      const lent = await grantChannels(session.agent_group_id, existing.id, req.channels);
      if (lent.refusal) {
        await respond(session, req, 'error', `spawn_worker failed: ${lent.refusal}`);
        log.warn('spawn_worker could not lend a channel to a reused worker', {
          repo: req.repo,
          worker: existing.id,
          refusal: lent.refusal,
        });
        return false;
      }
      const delivery = await deliverBrief(session, existing.id, req.task);
      await respond(session, req, 'reused', briefedText(localName, req.repo, true, delivery));
      log.info('spawn_worker reused an existing worker', {
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
    log.warn('spawn_worker: worker exists for this thread but the requester has no destination for it', {
      repo: req.repo,
      worker: existing.id,
      originSession: session.id,
    });
  }
  return true;
}

/** Guard deny body: tell the requester, through the same channel it is waiting on. */
export async function denySpawnWorker(
  content: Record<string, unknown>,
  session: Session,
  reason: string,
): Promise<void> {
  await respond(session, parseRequest(content), 'error', `spawn_worker denied: ${reason}`);
}

/** Guard allow body: creates the worker and briefs it. */
export async function spawnWorker(content: Record<string, unknown>, session: Session): Promise<void> {
  const req = parseRequest(content);
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!req.repo || !req.task || !sourceGroup) return; // precheck already answered the requester

  // Resolved AGAIN here, and reuse re-checked, in case a concurrent
  // spawn_worker call for the same (repo, thread) already created a worker
  // between the precheck's lookup and this one. Creating anyway would put two
  // agents on two branches of one repository in one conversation, which is
  // the exact failure the (repo, thread) key exists to prevent.
  let repoPath: string;
  try {
    repoPath = resolveRepo(req.repo, PROJECT_ROOTS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await respond(session, req, 'error', message);
    log.error('spawn_worker failed: repo no longer resolvable', { repo: req.repo, err });
    return;
  }

  const existing = await existingWorkerFor(repoPath, session.id);
  const reuseName = existing && (await reusableWorkerName(sourceGroup.id, existing));
  if (existing && reuseName) {
    const lent = await grantChannels(sourceGroup.id, existing.id, req.channels);
    if (lent.refusal) {
      await respond(session, req, 'error', `spawn_worker failed: ${lent.refusal}`);
      return;
    }
    const delivery = await deliverBrief(session, existing.id, req.task);
    await respond(session, req, 'reused', briefedText(reuseName, req.repo, true, delivery));
    log.info('spawn_worker reused an existing worker', {
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
    log.error('spawn_worker failed: could not prepare the repo worktree', { repo: req.repo, err });
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

  const lent = await grantChannels(sourceGroup.id, outcome.agentGroupId, req.channels);
  if (lent.refusal) {
    await respond(session, req, 'error', `spawn_worker failed: ${lent.refusal}`);
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
