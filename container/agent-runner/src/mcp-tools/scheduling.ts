/**
 * Delegation MCP tool: run_task.
 *
 * Runs an instruction in a SEPARATE session — its own container, its own
 * transcript, alongside this conversation rather than inside it.
 *
 * With `repo` that session also stands in a git worktree of that repository,
 * so it loads that repository's `CLAUDE.md`, `.claude/skills/` and
 * `.claude/settings.json`. That is the one thing a `Task` subagent cannot do,
 * because `Task` shares the caller's cwd. Without `repo` there is no worktree
 * and cwd stays the group folder — what the call buys then is the separate
 * session itself: long work that must not hold up this turn.
 *
 * ONE CALL DOES EVERYTHING. The host resolves the repository, adopts or
 * creates the workspace, and queues the run. There is no `ncl tasks create`
 * step and no generated id to read back first.
 *
 * IDENTITY IS DERIVED, NOT PASSED. The workspace is the pair (repository,
 * this session), so calling twice for one repository in one conversation
 * reuses the first workspace and its branch. That is why there is no
 * workspace or series argument: naming it would let two calls disagree about
 * which one they meant.
 *
 * TWO DELIVERY MODES, decided by `notify`, and the mechanism is `requestId`:
 * minted only when an answer was asked for, and the host writes nothing
 * without one.
 *
 *   run_task({ instruction })                       fire and forget, own workspace
 *   run_task({ repo, instruction })                 fire and forget, in a repository
 *   run_task({ repo, instruction, notify: true })   the result wakes you
 *
 * There is deliberately no blocking mode. A run is a whole agent turn in
 * another session, so a bounded wait would mostly burn this caller's turn
 * sitting idle; `notify` costs one turn and loses nothing.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

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

export const runTask: McpToolDefinition = {
  tool: {
    name: 'run_task',
    description:
      "Delegate work to a SEPARATE session, running alongside this conversation rather than inside it. With repo it stands in a git worktree of that repository, so it loads that repository's CLAUDE.md, commands, skills and settings — the only way to work in a repository other than the one you are standing in. Without repo it runs in your own workspace. " +
      'CHOOSING BETWEEN THIS AND THE Task TOOL: compare the repository you need against the one you are standing in. ' +
      'Same repository, and you want the answer in this turn — use Task. It shares your working directory and costs nothing. ' +
      'Different repository — use this with repo. Task CANNOT change directory, so pointing it at another repository reads YOUR files while reporting on that one, and the answer looks correct. ' +
      'Same repository but long-running — use this without repo, so the work proceeds in its own session instead of holding up this turn. ' +
      'A SLASH COMMAND IS A VALID INSTRUCTION, e.g. "/blueprint FMTA-343" — it runs as a real command in the run\'s own session with THAT repository\'s commands and skills loaded, which is the only way to invoke a command that lives in another repository. Reach for this whenever the request names a command plus a ticket or an issue. A command carrying no subject of its own ("/implement") must be followed by the brief. ' +
      'ONE CALL DOES EVERYTHING: the workspace is created or reused AND the instruction is queued — do not follow this with anything else. ' +
      'CALLING IT TWICE THE SAME WAY reuses the same workspace and branch, so follow-up work sees the earlier work. ' +
      'THE RESULT IS ASYNCHRONOUS: with notify it arrives later as a message that wakes you, so end your turn after the call. ' +
      'Only name a repository the user named; an unknown repository fails rather than guessing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: {
          type: 'string',
          description:
            'Repository NAME, e.g. "saber" or "wego/saber" — resolved host-side against the operator allowlist. Never a path, never absolute. OMIT IT to run in your own workspace instead: still a separate session with its own transcript, running alongside this conversation, but no repository and no worktree.',
        },
        instruction: {
          type: 'string',
          description:
            'What to do, delivered as the run\'s entire brief. The run starts with an empty context and cannot read this conversation, so expand every reference ("this bug", "as discussed") into explicit text: what to do, in which files, and what the result must be. May instead begin with a slash command, which is dispatched as a command in the run\'s own session.',
        },
        notify: {
          type: 'boolean',
          description:
            "Wake me with the run's result when it finishes. Without it the run still happens, but you are never told how it went.",
        },
      },
      required: ['instruction'],
    },
  },
  async handler(args) {
    const repo = ((args.repo as string) || '').trim();
    const instruction = ((args.instruction as string) || '').trim();
    if (!instruction) return err('instruction is required — the brief the run starts from.');

    // No requestId means the host writes no answer and sends no wake. That is
    // the fire-and-forget contract, expressed as an absent field rather than a
    // flag the host would have to interpret.
    const wants = args.notify === true;
    const requestId = wants ? generateId() : '';
    // Minted unconditionally, unlike requestId — a delivery RETRY of this
    // exact system message carries the same content and therefore the same
    // runId, which is what lets the host converge a retry on the occurrence
    // it already queued instead of minting a second one.
    const runId = generateId();

    await writeMessageOut({
      id: requestId || generateId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'run_task',
        requestId,
        // Never polls: this tool has no blocking mode, so the host always
        // takes the wake path when there is a requestId at all.
        waitUntil: null,
        runId,
        // Passed through unvalidated ON PURPOSE. This container cannot be
        // relied on to gate itself, so the host resolves the name against its
        // own allowlist and refuses everything else.
        repo,
        instruction,
      }),
    });

    const where = repo ? `"${repo}"` : 'a separate session in your own workspace';
    log(`run_task: ${repo || '(no repo)'} (requestId=${requestId || 'none'})`);

    if (!requestId) {
      return ok(
        `Queued in ${where}. You asked for no result, so nothing further will arrive — ` +
          `pass notify: true if you need to know how it went.`,
      );
    }
    return ok(
      `Queued in ${where}. The result will arrive later as a message that wakes you — end your turn now. ` +
        `Tell the human you are waiting rather than going silent.`,
    );
  },
};

/**
 * Answer a question a run you started is blocked on.
 *
 * A task run is headless: its own question card has nowhere to go until it has
 * posted something, and even then it lands in a thread nobody may be reading.
 * So the host relays the question to whoever started the run — you — and this
 * is the door back. The run is parked polling for the answer and continues
 * within a second of it arriving.
 */
export const answerTaskQuestion: McpToolDefinition = {
  tool: {
    name: 'answer_task_question',
    description:
      'Answer a question that a run you started with run_task is BLOCKED on. You receive the question, its options, and its questionId as a message. ' +
      'Ask the human and pass back their choice verbatim — one of the exact option values, never your own judgement of what they would say. ' +
      'The run resumes immediately. It can only answer a question from a run you started yourself.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        questionId: {
          type: 'string',
          description:
            'The questionId from the relayed question. Copy it exactly; it is how the host finds the blocked run.',
        },
        answer: {
          type: 'string',
          description: "The human's choice, exactly as one of the option values offered by the question.",
        },
      },
      required: ['questionId', 'answer'],
    },
  },
  async handler(args) {
    const questionId = ((args.questionId as string) || '').trim();
    const answer = ((args.answer as string) || '').trim();
    if (!questionId) return err('questionId is required — copy it from the relayed question.');
    if (!answer) return err('answer is required — one of the option values the question offered.');

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'answer_task_question',
        requestId,
        waitUntil: null,
        questionId,
        answer,
      }),
    });

    log(`answer_task_question: ${questionId}`);
    return ok(
      `Sent "${answer}" to the blocked run. NOT CONFIRMED YET: the host checks that the question is still open and ` +
        `that the run is yours, and answers either way — end your turn and wait for it.`,
    );
  },
};

registerTools([runTask, answerTaskQuestion]);
