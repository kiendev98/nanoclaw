/**
 * Repo worker MCP tools: spawn_worker, answer_worker.
 *
 * A worker is not a companion agent. It is a delegate that stands inside
 * ANOTHER repository — its own process, its own working directory, a git
 * worktree of that repository — so it loads that repository's `CLAUDE.md`,
 * `.claude/skills/` and `.claude/settings.json`. That is the only thing a
 * `Task` subagent cannot do, because `Task` shares the caller's cwd.
 *
 * ONE CALL DOES EVERYTHING. The host resolves the repository, creates or
 * reuses the worktree and the agent group, writes the destination rows, and
 * delivers `task` to the worker as its brief. The caller is never woken just
 * to learn the worker exists and then send it a message in a second turn —
 * that hop was the whole reason this tool was split out of `create_agent`.
 *
 * BLOCKING, BUT BOUNDED (the ask_user_question / canvas_read pattern): the
 * tool writes a `spawn_worker` system action carrying its `requestId`, then
 * polls `findCliResponse(requestId)` for the host's answer. The bound is one
 * minute because `git worktree add` on a large checkout is not instant — one
 * of the repositories this runs against is 7.5 GB.
 *
 * IT NEVER BLOCKS ON A HUMAN — creating a worker needs no admin approval, so
 * there is no hold to answer inline. The only thing that can still outrun the
 * bound is the worktree checkout itself: on timeout the tool reports that
 * creation is still running, and the host wakes the caller when it finishes.
 *
 * `answer_worker` closes the other half of the loop. A worker has no channel,
 * so `ask_user_question` sends its question up this same lane and BLOCKS. The
 * problem that makes a second verb necessary is that no existing door carries
 * intent: `send_message` and a reused `spawn_worker` both end in
 * `routeAgentMessage` and write a byte-identical `kind: 'chat'` row, so a
 * blocked worker could only guess which message was its answer. It guessed by
 * order, and a second instruction sent during the same turn was silently
 * relabelled as the decision. This tool writes a `question_response` instead —
 * the same row a button click produces — so the answer reaches the waiting
 * call and an ordinary message reaches the model, each by its own door.
 */
import { findByName, getAllDestinations } from '../destinations.js';
import { findCliResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

/**
 * How long the tool waits for the host before degrading to "you will be
 * notified". Long enough for `git worktree add` on a multi-gigabyte
 * repository, short enough that it is never mistaken for waiting on a human.
 */
const DEFAULT_WAIT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

/**
 * The bound, in milliseconds.
 *
 * Mutable so a test can drive the timeout path in milliseconds instead of a
 * minute. Deliberately NOT an environment variable: this is a property of the
 * test run, never of an install, and a name in `process.env` invites someone to
 * set it in a `.env` where it would silently shorten every worker request.
 * Nothing in production writes to it.
 */
export const workerWaitBound = { ms: DEFAULT_WAIT_MS };

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function destinationList(): string {
  const all = getAllDestinations();
  return all.length === 0 ? '(none)' : all.map((d) => d.name).join(', ');
}

function generateId(): string {
  return `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The default worker name for a repository — `saber` and `wego/saber` both
 * become `saber-worker`. Derived here rather than host-side so the payload
 * always carries the name the caller will be handed back.
 */
export function defaultWorkerName(repo: string): string {
  const last = repo.split(/[/\\]/).filter(Boolean).pop() ?? '';
  return last ? `${last}-worker` : 'repo-worker';
}

/** The host's answer, as it arrives on the inbound row. */
interface WorkerResponse {
  status?: string;
  result?: { name?: string; repo?: string; message?: string; error?: string };
}

export const spawnWorker: McpToolDefinition = {
  tool: {
    name: 'spawn_worker',
    description:
      "Delegate a task into ANOTHER repository. Creates (or reuses) a worker: a separate agent with its OWN process and its OWN working directory, standing inside a git worktree of that repository and loading that repository's CLAUDE.md, skills and settings. " +
      'CHOOSING BETWEEN THIS AND THE Task TOOL: compare the repository you need against the one you are standing in. ' +
      'Same repository — use Task. It shares your working directory and costs nothing. ' +
      'Different repository — use this. Task CANNOT change directory, so pointing it at another repository reads YOUR files while reporting on that one, and the answer looks correct. ' +
      'ONE CALL DOES EVERYTHING: the worker is created or reused AND `task` is delivered to it as its brief — do not follow this with a message. ' +
      'THE RESULT IS ASYNCHRONOUS: this returns once the worker EXISTS and has been briefed. Its ANSWER arrives later as a message that wakes you, so end your turn after this call. ' +
      '`task` may be plain prose OR a literal slash command such as "/blueprint FMTA-343", which runs as a real command in the worker\'s session with that repository\'s commands and skills loaded — but the task is the worker\'s ENTIRE context, so a command that does not carry its own subject ("/implement") must be followed by the brief. ' +
      'Only name a repository the user named; an unknown repository fails rather than guessing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: {
          type: 'string',
          description:
            'Repository NAME, e.g. "saber" or "wego/saber" — resolved host-side against the operator allowlist. Never a path, never absolute.',
        },
        task: {
          type: 'string',
          description:
            'The brief, delivered to the worker as its first message. The worker starts with an empty context and cannot read this conversation, so expand every reference ("this bug", "as discussed") into explicit text: what to do, in which files, and what the result must be. May instead begin with a slash command, which is dispatched as a command in the worker\'s session.',
        },
        name: {
          type: 'string',
          description:
            'Optional name for the worker, which also becomes your destination name for it. Defaults to a name derived from the repository.',
        },
      },
      required: ['repo', 'task'],
    },
  },
  async handler(args) {
    const repo = ((args.repo as string) || '').trim();
    const task = ((args.task as string) || '').trim();
    if (!repo) return err('repo is required — the NAME of the repository the worker must stand in.');
    if (!task) return err('task is required — the brief the worker starts from.');
    const name = ((args.name as string) || '').trim() || defaultWorkerName(repo);

    const requestId = generateId();
    // waitUntil is the host's only way to know whether this call is still
    // listening. Inside the window the host answers on the inbound row alone;
    // past it the host also wakes the caller, because a late answer written
    // to a row nobody polls is silence.
    const bound = workerWaitBound.ms;
    const waitUntil = Date.now() + bound;
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'spawn_worker',
        requestId,
        waitUntil,
        // Passed through unvalidated ON PURPOSE. This container cannot be
        // relied on to gate itself, so the host resolves the name against its
        // own allowlist and refuses everything else — see
        // src/modules/agent-to-agent/create-worker.ts.
        repo,
        task,
        name,
      }),
    });

    log(`spawn_worker: ${requestId} → "${name}" in "${repo}"`);

    const deadline = waitUntil;
    while (Date.now() < deadline) {
      const response = findCliResponse(requestId);
      if (response) {
        markCompleted([response.id]);
        const parsed = JSON.parse(response.content) as WorkerResponse;
        log(`spawn_worker response: ${requestId} → ${parsed.status}`);
        if (parsed.status === 'error') {
          // Say plainly that this is retryable. A refusal names what WOULD
          // have worked (`resolveRepo` lists the resolvable repositories), so
          // the useful next move is another call with a corrected argument —
          // not an apology to the human, and not a silent abandonment of the
          // delegation, which is what a bare error message tends to produce.
          return err(
            `${parsed.result?.error || `Could not create a worker for "${repo}".`} ` +
              `Nothing was created, so this is safe to retry: correct the argument the message names and ` +
              `call spawn_worker again. Ask the human only if the message gives you nothing to correct.`,
          );
        }
        return ok(parsed.result?.message || `Worker "${name}" is ready in "${repo}".`);
      }
      await sleep(Math.min(POLL_INTERVAL_MS, bound));
    }

    log(`spawn_worker timeout: ${requestId}`);
    return ok(
      `Worker "${name}" for "${repo}" is still being created — checking out a large repository takes a while. ` +
        `You will be woken when it exists and has your task. Tell the human you are waiting rather than going silent.`,
    );
  },
};

/**
 * How long `answer_worker` waits for the host to say what became of the
 * answer. Short, because the host does no real work here: it looks up one row
 * and writes another. Anything longer is waiting on delivery polling, not on
 * the operation.
 */
const ANSWER_WAIT_MS = 30_000;

/** The host's answer to `answer_worker`, as it arrives on the inbound row. */
interface AnswerResponse {
  status?: string;
  result?: { message?: string; error?: string };
}

export const answerWorker: McpToolDefinition = {
  tool: {
    name: 'answer_worker',
    description:
      'Answer a worker that is BLOCKED waiting on a question it asked you. Use this and nothing else to reply to such a question. ' +
      'A worker has no channel of its own, so when it needs a decision it asks you, and it stops until you answer. ' +
      'WHY THIS IS NOT send_message: an ordinary message reaches the worker as NEW WORK, arriving beside the question rather than in place of it, and the worker stays blocked until it gives up. ' +
      'This tool unblocks the waiting call, so the worker continues mid-thought with its full context intact. ' +
      "Answer from what you already know when you can. When the decision is the human's, ask them through your own channel first, then relay their answer here. " +
      'Send the ANSWER ITSELF, not an acknowledgement — "let me check with them" is a decision the worker cannot act on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        worker: {
          type: 'string',
          description: 'The worker to answer, by the destination name you know it as (the name spawn_worker returned).',
        },
        answer: {
          type: 'string',
          description:
            'The decision, stated plainly. Prefer one of the options the worker offered; any text is accepted, since a worker often asks an open question.',
        },
      },
      required: ['worker', 'answer'],
    },
  },
  async handler(args) {
    const worker = ((args.worker as string) || '').trim();
    const answer = ((args.answer as string) || '').trim();
    if (!worker) return err(`worker is required. Options: ${destinationList()}`);
    if (!answer) return err('answer is required — the decision the worker is waiting on.');

    // Resolved here, against the map the host projected into this session, for
    // the same reason `send_message` resolves it here: the map only ever holds
    // destinations this agent group legitimately has. The host re-checks the
    // destination anyway before it delivers anything.
    const dest = findByName(worker);
    if (!dest) return err(`Unknown destination "${worker}". Known: ${destinationList()}`);
    if (dest.type !== 'agent') {
      return err(
        `"${worker}" is a channel, not an agent. answer_worker replies to a worker that asked you a question.`,
      );
    }

    const requestId = generateId();
    const waitUntil = Date.now() + ANSWER_WAIT_MS;
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'answer_worker',
        requestId,
        waitUntil,
        worker: dest.agentGroupId,
        workerName: worker,
        answer,
      }),
    });

    log(`answer_worker: ${requestId} -> "${worker}"`);

    while (Date.now() < waitUntil) {
      const response = findCliResponse(requestId);
      if (response) {
        markCompleted([response.id]);
        const parsed = JSON.parse(response.content) as AnswerResponse;
        log(`answer_worker response: ${requestId} -> ${parsed.status}`);
        if (parsed.status === 'error') {
          return err(parsed.result?.error || `Could not answer "${worker}".`);
        }
        return ok(parsed.result?.message || `Answer delivered to "${worker}".`);
      }
      await sleep(POLL_INTERVAL_MS);
    }

    log(`answer_worker timeout: ${requestId}`);
    return ok(
      `The answer for "${worker}" was sent and is still being delivered. Do not send it again — a second copy ` +
        `would reach the worker as new work.`,
    );
  },
};

registerTools([spawnWorker, answerWorker]);
