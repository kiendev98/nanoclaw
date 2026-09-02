/**
 * Task scheduling MCP tool: run_task.
 *
 * Everything else about tasks is `ncl tasks` — create, list, pause, cancel,
 * and `ncl tasks run` to fire one now. This tool exists for the one thing a
 * CLI cannot do: hand the RESULT back. A CLI call returns and is over, so it
 * can start a run but can never tell you how the run ended.
 *
 * WHY RUN A TASK AT ALL RATHER THAN DOING THE WORK. A task series owns a
 * session, and a session can own things this one cannot: a git worktree of
 * another repository (`ncl tasks create --repo`), its own memory, and a Slack
 * thread it opened. Running in that session is how work reaches another
 * repository's CLAUDE.md, skills and settings — the thing `Task` cannot do,
 * because `Task` shares your working directory.
 *
 * THREE MODES, AND THE ARGUMENTS PICK ONE:
 *
 *   run_task({ series })                 fire and forget — no answer, ever
 *   run_task({ series, notify: true })   returns now; the answer wakes you
 *   run_task({ series, wait_ms: 60000 }) waits, then degrades to the wake
 *
 * The mechanism is `requestId`: minted only when an answer was asked for, and
 * the host writes nothing without one. `wait_ms` cannot lose a result — when
 * the bound expires the host takes the wake path instead, so a too-short wait
 * degrades rather than drops.
 */
import { findCliResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

/**
 * Ceiling on `wait_ms`. A task run is a whole agent turn in another session,
 * so it can take minutes; blocking this call for minutes would burn the
 * caller's turn doing nothing. Past the ceiling the answer arrives by wake,
 * which costs one turn and loses nothing.
 */
const MAX_WAIT_MS = 300_000;
const POLL_INTERVAL_MS = 500;

/**
 * The bound actually used, in milliseconds.
 *
 * Mutable so a test can drive the timeout path in milliseconds. Deliberately
 * NOT an environment variable: this is a property of the test run, never of an
 * install. Nothing in production writes to it.
 */
export const runTaskWaitCeiling = { ms: MAX_WAIT_MS };

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `runtask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

/** The host's answer, as it arrives on the inbound row. */
interface RunTaskResponse {
  status?: string;
  result?: { message?: string; error?: string };
}

/**
 * How long to poll, and whether an answer was asked for at all.
 *
 * `wait_ms` implies `notify`, because a bounded wait that expires has to hand
 * off to something. Only the bare call — neither argument — is silent.
 */
function resolveMode(args: Record<string, unknown>): { wants: boolean; waitMs: number } {
  const raw = typeof args.wait_ms === 'number' && Number.isFinite(args.wait_ms) ? Math.trunc(args.wait_ms) : 0;
  const waitMs = Math.max(0, Math.min(raw, runTaskWaitCeiling.ms));
  return { wants: waitMs > 0 || args.notify === true, waitMs };
}

export const runTask: McpToolDefinition = {
  tool: {
    name: 'run_task',
    description:
      'Run an EXISTING task series once, now, without changing its schedule. The run happens in that series\' own session — which may stand in another repository\'s git worktree, with that repository\'s CLAUDE.md and skills loaded — so this is how you hand work to another working directory. ' +
      'CHOOSING BETWEEN THIS AND THE Task TOOL: same repository and no separate session needed — use Task, it costs nothing. Another repository, or work that must keep its own memory or its own Slack thread — use this. ' +
      'THE SERIES MUST ALREADY EXIST: create it with `ncl tasks create` (add --repo to give it a worktree), then name it here. `ncl tasks list` shows the ids. ' +
      'THREE MODES. Neither argument: fire and forget, you are never told how it went. notify: true — returns immediately and the run\'s result arrives later as a message that wakes you, so end your turn. wait_ms: N — waits up to N milliseconds for the result; if the run outlasts that, it falls back to waking you, so nothing is lost. ' +
      'Prefer notify or a plain call for anything long. A task run is a whole agent turn, so a large wait_ms mostly means sitting idle.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        series: {
          type: 'string',
          description: 'Task series id, as `ncl tasks list` shows it (e.g. "pr-review-a25c").',
        },
        notify: {
          type: 'boolean',
          description:
            'Ask to be woken with the result when the run finishes. Returns immediately. Ignored when wait_ms is set, which already implies it.',
        },
        wait_ms: {
          type: 'number',
          description:
            'Block up to this many milliseconds for the result. Capped at 300000. On expiry the result arrives by wake instead.',
        },
      },
      required: ['series'],
    },
  },
  async handler(args) {
    const series = ((args.series as string) || '').trim();
    if (!series) return err('series is required — the id of an existing task series, from `ncl tasks list`.');

    const { wants, waitMs } = resolveMode(args);
    // No requestId means the host writes no answer and sends no wake. That is
    // the fire-and-forget contract, expressed as an absent field rather than a
    // flag the host would have to interpret.
    const requestId = wants ? generateId() : '';
    const waitUntil = waitMs > 0 ? Date.now() + waitMs : null;

    await writeMessageOut({
      id: requestId || generateId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'run_task',
        requestId,
        waitUntil,
        // Passed through unvalidated ON PURPOSE: the host resolves the series
        // inside the caller's own agent group and refuses anything else.
        series,
      }),
    });

    log(`run_task: ${series} (requestId=${requestId || 'none'}, waitMs=${waitMs})`);

    if (!requestId) {
      return ok(
        `Queued one run of "${series}". You asked for no result, so nothing further will arrive — ` +
          `re-run with notify: true if you need to know how it went.`,
      );
    }

    if (waitUntil === null) {
      return ok(
        `Queued one run of "${series}". Its result will arrive later as a message that wakes you — end your turn now.`,
      );
    }

    while (Date.now() < waitUntil) {
      const response = findCliResponse(requestId);
      if (response) {
        markCompleted([response.id]);
        const parsed = JSON.parse(response.content) as RunTaskResponse;
        log(`run_task response: ${requestId} → ${parsed.status}`);
        if (parsed.status === 'error') return err(parsed.result?.error || `Could not run "${series}".`);
        return ok(parsed.result?.message || `Run of "${series}" finished.`);
      }
      await sleep(Math.min(POLL_INTERVAL_MS, waitMs));
    }

    log(`run_task timeout: ${requestId}`);
    return ok(
      `"${series}" is still running — it outlasted the ${waitMs}ms wait. ` +
        `You will be woken with its result when it finishes. Tell the human you are waiting rather than going silent.`,
    );
  },
};

registerTools([runTask]);
