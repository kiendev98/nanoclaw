/**
 * `worker_delegate` — create or reuse the helper and deliver the task, in one
 * call (A1).
 *
 * SECURITY: this writes central-DB state (an agent group, a session) and
 * creates a git worktree on the host — privileged work a confined container is
 * otherwise barred from. Authorization is the guard's, host-side: the
 * container's own tool gate is inside the untrusted container and is bypassed
 * by writing the outbound system row directly.
 */
import { getAgentGroup } from '../../../db/agent-groups.js';
import { log } from '../../../log.js';
import type { Session } from '../../../types.js';
import { requestApproval } from '../../approvals/index.js';
import { isUniqueViolation } from '../../../db/errors.js';
import { claimTaskForFinalize, createTask, findRunningTask } from '../db/worker-tasks.js';
import { ensureHelperAgentGroup, ensureHelperSession, providerOf } from './helper-session.js';
import { deliverToSession, replyToCaller } from '../notify.js';
import { WORKER_DELEGATE_ACTION } from '../guard.js';
import { generateId } from '../ids.js';
import { describeRefusal, isRepoRefusal, resolveRepo } from './repo-registry.js';
import { WorktreeError } from './worktree.js';
import type { WorkerTask } from '../types.js';

interface DelegateRequest {
  repository: string;
  task: string;
  /** The conversation the request was made in, as the container saw it. */
  threadId: string | null;
}

function readRequest(content: Record<string, unknown>): DelegateRequest {
  return {
    repository: typeof content.repository === 'string' ? content.repository.trim() : '',
    task: typeof content.task === 'string' ? content.task.trim() : '',
    threadId: typeof content.threadId === 'string' && content.threadId ? content.threadId : null,
  };
}

/**
 * Guard precheck: everything a caller can fix itself is answered here, so a
 * mistyped repository name never cards a human.
 */
export async function validateDelegateTask(content: Record<string, unknown>, session: Session): Promise<boolean> {
  const request = readRequest(content);
  if (!request.repository) {
    await replyToCaller(session, 'delegate_task failed: name the repository. Never infer it.');
    return false;
  }
  if (!request.task) {
    await replyToCaller(session, 'delegate_task failed: the task must stand alone, and it is empty.');
    return false;
  }
  if (!session.messaging_group_id) {
    await replyToCaller(session, 'delegate_task failed: this session is not attached to a conversation.');
    return false;
  }
  const repo = resolveRepo(request.repository);
  if (isRepoRefusal(repo)) {
    await replyToCaller(session, `delegate_task failed: ${describeRefusal(repo)}`);
    return false;
  }
  if (!(await getAgentGroup(session.agent_group_id))) {
    await replyToCaller(session, 'delegate_task failed: the requesting agent group no longer exists.');
    return false;
  }
  return true;
}

/** Guard hold: card the requesting group's admin chain. */
export async function requestDelegateTaskHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const request = readRequest(content);
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!sourceGroup) return;

  await requestApproval({
    session,
    agentName: sourceGroup.name,
    action: WORKER_DELEGATE_ACTION,
    // The whole request, not a summary of it. An approved replay re-enters the
    // handler with THIS payload as its content, so a field dropped here is a
    // field the approved call runs without.
    payload: { repository: request.repository, task: request.task, threadId: request.threadId },
    title: `Delegate into ${request.repository}`,
    question: `Agent "${sourceGroup.name}" wants a worker to do this in the "${request.repository}" repository: ${request.task}. Approve?`,
  });
}

/**
 * Guard allow body: create or reuse the helper, then hand it the task.
 *
 * The helper is given no destination row of any kind, which is what makes B7
 * structural — there is no general-purpose door back to the principal for it to
 * find, only the single-purpose worker tools.
 */
export async function delegateTask(content: Record<string, unknown>, session: Session): Promise<void> {
  const request = readRequest(content);
  const repo = resolveRepo(request.repository);
  if (isRepoRefusal(repo) || !session.messaging_group_id) return; // precheck already answered

  const helper = await ensureHelperAgentGroup(session.agent_group_id, repo, await providerOf(session.agent_group_id));
  const threadId = session.thread_id ?? request.threadId;

  let helperSessionId: string;
  try {
    const resolved = await ensureHelperSession(helper, {
      messagingGroupId: session.messaging_group_id,
      threadId,
    });
    helperSessionId = resolved.workerSession.helper_session_id;
  } catch (err) {
    const text = err instanceof WorktreeError ? err.message : `Could not prepare a worker for "${repo.name}".`;
    log.error('Worker session preparation failed', { repoName: repo.name, err });
    await replyToCaller(session, `delegate_task failed: ${text}`);
    return;
  }

  const task: WorkerTask = {
    task_id: generateId('wt'),
    helper_session_id: helperSessionId,
    helper_agent_group_id: helper.helper_agent_group_id,
    repo_name: repo.name,
    principal_agent_group_id: session.agent_group_id,
    principal_session_id: session.id,
    description: request.task,
    status: 'running',
    draft_answer: null,
    progress_note_count: 0,
    last_progress_note_at: null,
    created_at: new Date().toISOString(),
    completed_at: null,
  };
  // A helper session is reused for a second task in the same thread, and it
  // works one task at a time. The unique index refuses the second, so a
  // follow-up cannot leave the first running forever with nobody to report it.
  try {
    await createTask(task);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const running = await findRunningTask(helperSessionId);
    await replyToCaller(
      session,
      `delegate_task failed: the ${repo.name} worker is still on task ${running?.task_id ?? 'its current task'}. Wait for its report, or answer its question.`,
    );
    return;
  }

  const delivered = await deliverToSession(
    helper.helper_agent_group_id,
    helperSessionId,
    [`New task (id ${task.task_id}) in the ${repo.name} repository:`, '', request.task].join('\n'),
    'principal',
  );

  // The task row would otherwise sit `running` with nobody working it, and the
  // caller was promised exactly one report. Take it back and say so, rather
  // than blocking the next delegation behind a task that never started.
  if (!delivered) {
    await claimTaskForFinalize(task.task_id, new Date().toISOString());
    log.error('Worker task undeliverable', { taskId: task.task_id, helperSessionId });
    await replyToCaller(session, `delegate_task failed: the ${repo.name} worker session could not be reached.`);
    return;
  }

  await replyToCaller(
    session,
    `Delegated to the ${repo.name} worker (task ${task.task_id}). You will receive exactly one report when it finishes.`,
  );
  log.info('Worker task delegated', { taskId: task.task_id, repoName: repo.name, helperSessionId });
}
