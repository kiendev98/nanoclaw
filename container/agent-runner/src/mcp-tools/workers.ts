/**
 * Repo worker MCP tool: create_worker.
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
 * tool writes a `create_worker` system action carrying its `requestId`, then
 * polls `findCliResponse(requestId)` for the host's answer. The bound is one
 * minute because `git worktree add` on a large checkout is not instant — one
 * of the repositories this runs against is 7.5 GB.
 *
 * IT NEVER BLOCKS ON A HUMAN. An admin approval can sit for hours, so the
 * host answers a held request IMMEDIATELY with `status: 'pending'` and the
 * caller is told to say it is waiting rather than going silent. Every other
 * late outcome degrades the same way: on timeout the tool reports that
 * creation is still running, and the host wakes the caller when it finishes.
 */
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
 * The bound, in milliseconds. `NANOCLAW_CREATE_WORKER_WAIT_MS` exists so a
 * test can drive the timeout path in milliseconds instead of a minute; it is
 * not an operator knob and nothing sets it in production.
 */
function waitMs(): number {
  const override = Number(process.env.NANOCLAW_CREATE_WORKER_WAIT_MS);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_WAIT_MS;
}

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
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

export const createWorker: McpToolDefinition = {
  tool: {
    name: 'create_worker',
    description:
      'Delegate a task into ANOTHER repository. Creates (or reuses) a worker: a separate agent with its OWN process and its OWN working directory, standing inside a git worktree of that repository and loading that repository\'s CLAUDE.md, skills and settings. ' +
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
    const bound = waitMs();
    const waitUntil = Date.now() + bound;
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_worker',
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

    log(`create_worker: ${requestId} → "${name}" in "${repo}"`);

    const deadline = waitUntil;
    while (Date.now() < deadline) {
      const response = findCliResponse(requestId);
      if (response) {
        markCompleted([response.id]);
        const parsed = JSON.parse(response.content) as WorkerResponse;
        log(`create_worker response: ${requestId} → ${parsed.status}`);
        if (parsed.status === 'error') {
          return err(parsed.result?.error || `Could not create a worker for "${repo}".`);
        }
        return ok(parsed.result?.message || `Worker "${name}" is ready in "${repo}".`);
      }
      await sleep(Math.min(POLL_INTERVAL_MS, bound));
    }

    log(`create_worker timeout: ${requestId}`);
    return ok(
      `Worker "${name}" for "${repo}" is still being created — checking out a large repository takes a while. ` +
        `You will be woken when it exists and has your task. Tell the human you are waiting rather than going silent.`,
    );
  },
};

registerTools([createWorker]);
