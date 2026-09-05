/**
 * Worker-delegation MCP tools.
 *
 * Six tools, and every one of them carries exactly one meaning (B7). There is
 * deliberately no general-purpose message door between a helper and its
 * principal: one would turn the single answer into many, and no instruction
 * could stop it.
 *
 * Each tool writes an outbound system row and returns. Authorization is
 * host-side, in the guard — the container is untrusted, so a gate written here
 * would be a gate the caller can edit.
 */
import { getAgentMailbox } from '../mailbox/index.js';
import { getSessionRouting } from '../db/session-routing.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/**
 * The conversation this turn belongs to.
 *
 * The session's own thread is null under the `shared` and `agent-shared`
 * session modes, so the latest inbound route is asked instead — a helper is
 * keyed on the thread, and that key has to mean the same thing under all three
 * modes.
 */
function currentThreadId(): string | null {
  const routing = getSessionRouting();
  if (routing.thread_id) return routing.thread_id;
  if (!routing.channel_type || !routing.platform_id) return null;
  try {
    return (
      getAgentMailbox().operations.getLatestInboundRoute(routing.channel_type, routing.platform_id)?.threadId ?? null
    );
  } catch (cause) {
    // Falling back to null re-keys the worker onto the conversation instead of
    // the thread, which silently reuses the wrong worker — and under `shared`
    // mode two live conversations would collide on the unthreaded key. A
    // refusal the caller can retry beats a worker holding someone else's task.
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.error(`[worker] inbound route lookup failed: ${detail}`);
    throw new ThreadLookupError(detail);
  }
}

/** The conversation could not be identified, so no worker may be keyed on it. */
class ThreadLookupError extends Error {
  constructor(detail: string) {
    super(`could not identify this conversation (${detail}). Try again in a moment.`);
    this.name = 'ThreadLookupError';
  }
}

async function writeWorkerAction(action: string, fields: Record<string, unknown>): Promise<void> {
  await writeMessageOut({
    id: generateId(),
    kind: 'system',
    content: JSON.stringify({ action, ...fields }),
  });
}

export const delegateTask: McpToolDefinition = {
  tool: {
    name: 'delegate_task',
    description:
      'Hand one task to a worker inside another repository. The person must NAME the repository — never infer it from the topic, from a file path, or from the repository you used last. The worker cannot read this conversation, so the task must stand alone. Creates the worker if this conversation has none for that repository, and reuses it if it has. You get exactly one report back. Fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repository: { type: 'string', description: 'The repository name the person named. No path, no guess.' },
        task: {
          type: 'string',
          description: 'A self-contained description of the work. The worker starts with no shared history.',
        },
      },
      required: ['repository', 'task'],
    },
  },
  async handler(args) {
    const repository = (args.repository as string) || '';
    const task = (args.task as string) || '';
    if (!repository) return err('repository is required. Ask the person which repository they mean.');
    if (!task) return err('task is required, and it must stand alone.');

    let threadId: string | null;
    try {
      threadId = currentThreadId();
    } catch (cause) {
      return err(cause instanceof Error ? cause.message : String(cause));
    }

    await writeWorkerAction('worker_delegate', { repository, task, threadId });
    log(`delegate_task → ${repository}`);
    return ok(`Delegating to the ${repository} worker. One report will come back when it finishes.`);
  },
};

export const askPrincipal: McpToolDefinition = {
  tool: {
    name: 'ask_principal',
    description:
      'Ask the assistant that gave you this task a question. Use it for a decision you cannot make alone, including anything a reviewer or other counterparty raises — a counterparty is not your principal. This does NOT block: end your turn after asking. The answer arrives as an ordinary message and wakes you again. You may hold only one open question at a time.',
    inputSchema: {
      type: 'object' as const,
      properties: { question: { type: 'string', description: 'The question, stated so it can be answered alone.' } },
      required: ['question'],
    },
  },
  async handler(args) {
    const question = (args.question as string) || '';
    if (!question) return err('question is required');
    await writeWorkerAction('worker_ask_principal', { question });
    return ok('Question sent. End your turn — the answer will wake you.');
  },
};

export const answerWorkerQuestion: McpToolDefinition = {
  tool: {
    name: 'answer_worker_question',
    description:
      "Answer one question a worker asked you. This is not the same as sending it new work, and an ordinary message is never treated as an answer. Answer from your own knowledge when you can. When the decision is the person's, put it to them with ask_user_question first and relay their reply here.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        questionId: { type: 'string', description: "The question id from the worker's question." },
        answer: { type: 'string', description: 'The answer.' },
      },
      required: ['questionId', 'answer'],
    },
  },
  async handler(args) {
    const questionId = (args.questionId as string) || '';
    const answer = (args.answer as string) || '';
    if (!questionId) return err('questionId is required');
    if (!answer) return err('answer is required');
    await writeWorkerAction('worker_answer_question', { questionId, answer });
    return ok(`Answer sent for question ${questionId}.`);
  },
};

export const sendProgressNote: McpToolDefinition = {
  tool: {
    name: 'send_progress_note',
    description:
      'Send one early note about a milestone. Send at least one once the task passes its first real milestone, such as exploration finishing or a blocker appearing. It is marked as progress and is never relayed to the person, so it is not your report. At most five per task, ten seconds apart. Anything past that is dropped. Do not narrate.',
    inputSchema: {
      type: 'object' as const,
      properties: { text: { type: 'string', description: 'The milestone, in one or two sentences.' } },
      required: ['text'],
    },
  },
  async handler(args) {
    const text = (args.text as string) || '';
    if (!text) return err('text is required');
    await writeWorkerAction('worker_progress_note', { text });
    return ok('Progress note sent.');
  },
};

export const lendConversation: McpToolDefinition = {
  tool: {
    name: 'lend_conversation',
    description:
      'Let a worker hold one conversation of its own, for work it must drive — a review loop, say. You may lend only a destination you already hold, and the worker is limited to the single conversation your message starts, never the channel. The access ends when the task does.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repository: { type: 'string', description: 'The repository whose worker gets the conversation.' },
        destination: { type: 'string', description: 'One of your own destination names.' },
        text: {
          type: 'string',
          description:
            'The opening message. It starts the thread the worker gets, and it is posted as a new top-level message. Do not mention or address the counterparty here. The worker mentions them in the message that carries the request.',
        },
      },
      required: ['repository', 'destination', 'text'],
    },
  },
  async handler(args) {
    const repository = (args.repository as string) || '';
    const destination = (args.destination as string) || '';
    const text = (args.text as string) || '';
    if (!repository || !destination || !text) return err('repository, destination and text are all required');

    let threadId: string | null;
    try {
      threadId = currentThreadId();
    } catch (cause) {
      return err(cause instanceof Error ? cause.message : String(cause));
    }

    await writeWorkerAction('worker_lend_conversation', {
      repository,
      destination,
      text,
      threadId,
    });
    return ok(`Lending one conversation in "${destination}" to the ${repository} worker.`);
  },
};

export const finishTask: McpToolDefinition = {
  tool: {
    name: 'finish_task',
    description:
      'Say your delegated task is finished, and give your final statement. This is the fast path only: if your run ends without it, the same statement is reported for you, so never treat reporting as something you must remember. Call it once, when the work is actually done — not while a subagent or a background job is still running.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        report: { type: 'string', description: 'Your final statement. This is what the person will be told.' },
      },
      required: ['report'],
    },
  },
  async handler(args) {
    const report = (args.report as string) || '';
    if (!report) return err('report is required');
    await writeWorkerAction('worker_done', { text: report });
    return ok('Reported. Your task is finished.');
  },
};

registerTools([delegateTask, askPrincipal, answerWorkerQuestion, sendProgressNote, lendConversation, finishTask]);
