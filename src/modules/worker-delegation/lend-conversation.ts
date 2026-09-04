/**
 * `worker_lend_conversation` — the principal lends its helper ONE conversation
 * on a channel it already holds (D1, D2).
 *
 * The lent reach is one thread, never the channel (D3). The root post is always
 * a fresh top-level message: E4 says ambiguity resolves toward posting visibly,
 * and silently joining a stranger's thread is the failure that is never
 * corrected. The platform names the thread only once that post is delivered, so
 * the grant is written unbound and stamped by the post-delivery hook.
 */
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { writeOutboundDirect, writeSessionRouting } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { requestApproval } from '../approvals/index.js';
import { createDestination, getDestinationByName, normalizeName } from '../agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../agent-to-agent/write-destinations.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { createGrant, findLiveGrantForSession } from './db/worker-channel-grants.js';
import { findWorkerSession } from './db/worker-sessions.js';
import { findRunningTask } from './db/worker-tasks.js';
import { WORKER_LEND_CONVERSATION_ACTION } from './guard.js';
import { generateId } from './ids.js';
import { replyToCaller } from './notify.js';
import type { MessagingGroup } from '../../types.js';
import type { WorkerChannelGrant, WorkerSession, WorkerTask } from './types.js';

interface LendRequest {
  repository: string;
  destination: string;
  text: string;
  threadId: string | null;
}

function readRequest(content: Record<string, unknown>): LendRequest {
  return {
    repository: typeof content.repository === 'string' ? content.repository.trim() : '',
    destination: typeof content.destination === 'string' ? content.destination.trim() : '',
    text: typeof content.text === 'string' ? content.text.trim() : '',
    threadId: typeof content.threadId === 'string' && content.threadId ? content.threadId : null,
  };
}

/** A local name for the lent conversation that the helper does not already use. */
async function freeDestinationName(helperAgentGroupId: string): Promise<string> {
  const preferred = normalizeName('conversation');
  let name = preferred;
  let suffix = 2;
  while (await getDestinationByName(helperAgentGroupId, name)) {
    name = `${preferred}-${suffix}`;
    suffix++;
  }
  return name;
}

export async function validateLendConversation(content: Record<string, unknown>, session: Session): Promise<boolean> {
  const request = readRequest(content);
  if (!request.repository || !request.destination || !request.text) {
    await replyToCaller(
      session,
      'lend_conversation failed: repository, destination and an opening message are all required.',
    );
    return false;
  }
  if (!session.messaging_group_id) {
    await replyToCaller(session, 'lend_conversation failed: this session is not attached to a conversation.');
    return false;
  }
  return true;
}

export async function requestLendConversationHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const request = readRequest(content);
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!sourceGroup) return;

  await requestApproval({
    session,
    agentName: sourceGroup.name,
    action: WORKER_LEND_CONVERSATION_ACTION,
    // The whole request. An approved replay re-enters the handler with THIS
    // payload as its content, and a lend that lost its opening message would
    // post an empty root and bind the grant to it.
    payload: {
      repository: request.repository,
      destination: request.destination,
      text: request.text,
      threadId: request.threadId,
    },
    title: `Lend "${request.destination}" to the ${request.repository} worker`,
    question: `Agent "${sourceGroup.name}" wants to let the "${request.repository}" worker hold one conversation in "${request.destination}". Approve?`,
  });
}

/** The conversation being lent, resolved from a name the caller holds. */
async function resolveLendTarget(session: Session, request: LendRequest): Promise<MessagingGroup | undefined> {
  const destination = await getDestinationByName(session.agent_group_id, request.destination);
  if (!destination) return undefined;
  return getMessagingGroup(destination.target_id);
}

/** The worker that will hold it, and the task whose lifetime bounds the grant. */
async function resolveLendableWorker(
  session: Session,
  request: LendRequest,
): Promise<{ workerSession: WorkerSession; task: WorkerTask } | string> {
  const workerSession = await findWorkerSession(
    request.repository,
    session.messaging_group_id ?? '',
    session.thread_id ?? request.threadId,
  );
  if (!workerSession) {
    return `no ${request.repository} worker is running for this conversation. Delegate a task first.`;
  }

  const task = await findRunningTask(workerSession.helper_session_id);
  if (!task) return 'that worker has no running task to hold it.';
  if (await findLiveGrantForSession(workerSession.helper_session_id)) {
    return 'that worker already holds a conversation.';
  }
  return { workerSession, task };
}

/**
 * Give the worker the destination and the grant, then post the root message.
 *
 * The post goes out from the PRINCIPAL's session as a fresh top-level message,
 * and its delivery is what creates the thread the grant binds to.
 */
async function openLentConversation(
  session: Session,
  messagingGroup: MessagingGroup,
  worker: { workerSession: WorkerSession; task: WorkerTask },
  text: string,
): Promise<string> {
  const { workerSession, task } = worker;
  const localName = await freeDestinationName(workerSession.helper_agent_group_id);
  const now = new Date().toISOString();
  await createDestination({
    agent_group_id: workerSession.helper_agent_group_id,
    local_name: localName,
    target_type: 'channel',
    target_id: messagingGroup.id,
    created_at: now,
  });

  const grant: WorkerChannelGrant = {
    task_id: task.task_id,
    helper_agent_group_id: workerSession.helper_agent_group_id,
    helper_session_id: workerSession.helper_session_id,
    messaging_group_id: messagingGroup.id,
    channel_type: messagingGroup.channel_type,
    platform_id: messagingGroup.platform_id,
    root_message_id: generateId('wlend'),
    thread_id: '',
    local_destination_name: localName,
    granted_by_session_id: session.id,
    granted_at: now,
    released_at: null,
  };
  await createGrant(grant);

  await writeOutboundDirect(session.agent_group_id, session.id, {
    id: grant.root_message_id,
    kind: 'chat',
    platformId: messagingGroup.platform_id,
    channelType: messagingGroup.channel_type,
    threadId: null,
    content: JSON.stringify({ text }),
  });

  // The worker resolves names from its own session's projected map, so the new
  // destination has to reach the live session, not only the central DB.
  await writeDestinations(workerSession.helper_agent_group_id, workerSession.helper_session_id);
  // Routing is otherwise projected once, at container spawn. A worker lent a
  // conversation mid-task is already running, so without this its routing keeps
  // the pre-grant state and every reply opens a new top-level post (D6).
  await writeSessionRouting(workerSession.helper_agent_group_id, workerSession.helper_session_id);
  log.info('Worker conversation lent', { taskId: task.task_id, destination: localName });
  return localName;
}

export async function lendConversation(content: Record<string, unknown>, session: Session): Promise<void> {
  const request = readRequest(content);
  if (!session.messaging_group_id) return; // precheck already answered

  const messagingGroup = await resolveLendTarget(session, request);
  if (!messagingGroup) return; // the guard already denied this shape

  const worker = await resolveLendableWorker(session, request);
  if (typeof worker === 'string') {
    await replyToCaller(session, `lend_conversation failed: ${worker}`);
    return;
  }

  const localName = await openLentConversation(session, messagingGroup, worker, request.text);
  await replyToCaller(
    session,
    `Lent one conversation in "${request.destination}" to the ${request.repository} worker. It posts there as "${localName}", and the access ends with the task.`,
  );
}
