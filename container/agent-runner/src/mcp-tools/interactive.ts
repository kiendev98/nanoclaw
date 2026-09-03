/**
 * Interactive MCP tools: ask_user_question, send_card.
 *
 * ask_user_question is a blocking tool call — it writes a messages_out row
 * with a question card, then polls messages_in for the response.
 *
 * IT ASKS WHOEVER CAN HEAR IT, and the session routing already says who that
 * is. `writeSessionRouting` splits on `session.messaging_group_id`: a session
 * that belongs to a chat routes to that channel and thread, and a session that
 * belongs to none routes down the agent lane to the group that spawned it.
 * So `channel_type === 'agent'` is not a test for "am I a worker" — it is the
 * test for "is there a person at the other end of my only address". A worker
 * later given a chat of its own stops escalating on the same line, with
 * nothing to remember to change.
 *
 * ON THE AGENT LANE THERE IS NO PERSON, and a question card sent down it used
 * to fail three times over, silently every time: `performAgentRoute` copies
 * the row into the orchestrator as kind `chat`, the formatter renders
 * `content.text` and a card carries none, so the orchestrator woke to an EMPTY
 * message; the host never created the `pending_questions` row, because that
 * code sits past delivery.ts's `channel_type === 'agent'` early return, so no
 * button existed anywhere; and the tool then polled for a response that could
 * not arrive, for the full five minutes, before reporting a timeout nobody
 * could explain.
 *
 * So on that lane the question is ESCALATED: sent to the orchestrator as
 * readable prose, and answered by it — from what it already knows, or by
 * putting the question to a human through its own channel, which is the one
 * place in the pair that has one. That hop is a filter, not a workaround.
 * Most worker questions never need to reach a person, because the agent that
 * wrote the brief already knows the answer.
 *
 * THE TOOL STILL BLOCKS, and that is what keeps this cheap. The turn never
 * ends, so there is no resume to arrange — the answer simply becomes this
 * call's return value and the model carries on mid-thought. The cost is a
 * bound: nobody is demonstrably waiting at the other end, and the host kills a
 * container whose heartbeat is 30 minutes stale.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { findQuestionResponse, markCompleted } from '../db/messages-in.js';
import { getSessionRouting } from '../db/session-routing.js';
import { getCurrentInReplyTo } from '../db/session-state.js';
import { isAgentLane } from '../session-lane.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function routing() {
  return getSessionRouting();
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

/** Seconds a question card waits on the human who can see it. */
const CHANNEL_TIMEOUT_S = 300;

/**
 * Seconds an escalated question waits on the orchestrator.
 *
 * Longer than the channel bound because this round trip may CONTAIN that one:
 * the orchestrator can put the question to a human through its own
 * `ask_user_question`, which itself waits 300s. A bound shorter than the hop
 * it wraps would give up while the human was still reading the card.
 *
 * Still well under the host's 30-minute idle ceiling for a running container
 * (`reconcile-session.ts`), so a waiting worker is never mistaken for a stuck
 * one and killed. Unbounded is not an option for the same reason: Claude
 * Code's own `askUserQuestionTimeout` defaults to `never`, but it can see that
 * a human is sitting at the terminal. Nothing here can see that.
 */
const ESCALATED_TIMEOUT_S = 600;

const POLL_INTERVAL_MS = 1000;

interface QuestionOption {
  label: string;
  selectedLabel: string;
  value: string;
}

/**
 * The question as the orchestrator reads it.
 *
 * It states the constraint rather than assuming the orchestrator knows it: the
 * asker cannot reach a person, and this lane is its only address. Without that
 * line the obvious reading of "ask the user" is that the asker already did,
 * and the orchestrator answers as a bystander.
 *
 * It also names the verb, because naming it is what removed the guessing. An
 * ordinary message and an answer used to be the same row, so the tool took the
 * first message carrying text and an orchestrator replying "ok, let me check
 * with them" spent the answer on an acknowledgement. `answer_worker` is a
 * different door, so that message is now simply new work and the wait goes on.
 */
export function renderEscalatedQuestion(title: string, question: string, options: QuestionOption[]): string {
  return [
    `${title} — I need a decision before I can continue.`,
    '',
    question,
    '',
    'Options:',
    ...options.map((o) => `- ${o.value}`),
    '',
    'I have no channel of my own and cannot reach a person. This lane back to you is my only address.',
    'If the choice is yours, answer it. If it is the human’s, ask them and relay what they say.',
    'Reply with the answer_worker tool. An ordinary message reaches me as NEW WORK, not as this answer, and I stay blocked.',
  ].join('\n');
}

type Routing = ReturnType<typeof getSessionRouting>;
type ToolResult = ReturnType<typeof ok>;

/**
 * The channel path, unchanged: post a card and wait for a button click.
 *
 * The host persists the question (`createPendingQuestion` in delivery.ts) and
 * routes the click back as a `question_response` system row, which the poll
 * loop skips by kind — so it reaches this poll and nothing else.
 */
async function askHuman(
  questionId: string,
  title: string,
  question: string,
  options: QuestionOption[],
  r: Routing,
  timeout: number,
): Promise<ToolResult> {
  await writeMessageOut({
    id: questionId,
    kind: 'chat-sdk',
    platform_id: r.platform_id,
    channel_type: r.channel_type,
    thread_id: r.thread_id,
    content: JSON.stringify({ type: 'ask_question', questionId, title, question, options }),
  });

  log(`ask_user_question: ${questionId} → "${question}" [${options.map((o) => o.value).join(', ')}]`);

  const answer = await awaitAnswer(questionId, timeout);
  if (answer !== null) {
    log(`ask_user_question response: ${questionId} → ${answer}`);
    return ok(answer);
  }

  log(`ask_user_question timeout: ${questionId}`);
  return err(`Question timed out after ${timeout / 1000}s`);
}

/**
 * Wait for the host's `question_response` row, on either lane.
 *
 * Both lanes end here, because both are now answered the same way: the host
 * writes a `question_response` system row and the poll loop skips system rows
 * by kind, so it reaches this poll and nothing else. The lane chose
 * card-versus-prose on the way out and decided nothing after that.
 *
 * The escalated lane used to need its own loop with its own rule for which
 * message counted, because an answer arrived as an ordinary `chat` row with no
 * mark on it. `answer_worker` is a door that carries the intent, so the rule is
 * gone and so is the loop that held it.
 *
 * @param timeout How long to wait, in milliseconds.
 * @returns The chosen option, or null once the deadline passes.
 */
async function awaitAnswer(questionId: string, timeout: number): Promise<string | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = findQuestionResponse(questionId);
    if (response) {
      const parsed = JSON.parse(response.content) as { selectedOption?: string };
      // processing_ack, in outbound.db — claims the row so the poll loop never
      // also pushes it at the model.
      markCompleted([response.id]);
      return parsed.selectedOption ?? '';
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

/**
 * The agent-lane path: hand the question to the orchestrator and wait.
 *
 * THE ENVELOPE HAS TWO READERS, and that is the whole mechanism. `text` is
 * prose for the orchestrator, whose formatter renders `content.text` and
 * nothing else — claiming a card no renderer here can honour is what made the
 * original failure invisible. `question` is structure for the host, which
 * reads it in delivery.ts's agent-lane branch and creates the pending question
 * there. That is the symmetric twin of what the channel path already does,
 * past the `channel_type === 'agent'` early return that used to skip it.
 *
 * So the answer is a return value rather than a message, which is the one
 * property worth copying from Claude Code's subagents. Its parent is blocked
 * inside the tool call and cannot send anything, so no ambiguity is possible;
 * here the orchestrator is free and can send other things, so the answer needs
 * its own row kind instead.
 *
 * `answer_worker` is the only door on THIS lane. The row itself has a second
 * producer — a human's button click, through modules/interactive — and that is
 * the point rather than an exception: both lanes end in the same
 * `findQuestionResponse` wait precisely because the two rows are identical.
 * An earlier version of this sentence claimed nothing else wrote one, which
 * would have made the shared wait below look like an accident.
 */
async function askOrchestrator(
  questionId: string,
  title: string,
  question: string,
  options: QuestionOption[],
  r: Routing,
  timeout: number,
): Promise<ToolResult> {
  // Computed BEFORE the write, so the instant the host stores is a little
  // EARLIER than the one this tool truly waits until (`awaitAnswer` starts its
  // clock after the write returns). That direction is deliberate. Expiring
  // early degrades a late answer to an ordinary message while the tool is
  // still listening — it arrives, as prose. Expiring late writes a
  // `question_response` nothing is polling for, which the poll loop drops by
  // kind: the answer is destroyed in silence. Given a choice of which way to
  // be wrong, be wrong in the direction that still delivers.
  const expiresAt = new Date(Date.now() + timeout).toISOString();

  await writeMessageOut({
    id: questionId,
    // Address the orchestrator SESSION that briefed this worker, not whichever
    // of its sessions spoke to the group most recently. `resolveTargetSession`
    // falls back to peer affinity without this, and destinations are
    // group-scoped, so a scheduled task or a second thread that messaged this
    // worker since the brief would take the question instead. That wrong
    // session may itself hold a thread binding, which would then surface the
    // question inside an unrelated human thread.
    in_reply_to: getCurrentInReplyTo(),
    // `chat`, not `chat-sdk`: on this lane it IS prose.
    kind: 'chat',
    platform_id: r.platform_id,
    channel_type: r.channel_type,
    thread_id: r.thread_id,
    content: JSON.stringify({
      text: renderEscalatedQuestion(title, question, options),
      // Rides ALONGSIDE the prose, never instead of it. `title` and `options`
      // travel because `pending_questions` requires both, and the host has no
      // other source for them on this lane. `expiresAt` travels because the
      // host cannot DERIVE it: `timeout` is caller-settable, so a copied
      // constant on that side is wrong the moment anyone passes one.
      question: { id: questionId, title, options, expiresAt },
    }),
  });

  log(`ask_user_question (escalated): ${questionId} -> "${question}" [${options.map((o) => o.value).join(', ')}]`);

  const answer = await awaitAnswer(questionId, timeout);
  if (answer !== null) {
    log(`ask_user_question answered by orchestrator: ${questionId} -> ${answer}`);
    return ok(answer);
  }

  // The answer may still be coming, and it will arrive as a NEW batch — with
  // this transcript still under it, because a worker resumes like any other
  // session. This used to need a flag: `freshSessionPerTask` wiped a worker's
  // transcript per batch, so the late answer would have landed as a bare "use
  // option B" with no question above it, and `markLateAnswerExpected` existed
  // solely to spare this one case from the wipe. No wipe, no exception.
  //
  // The host expires its pending row on the deadline THIS call sent it, so a
  // late `answer_worker` finds no open question and degrades to an ordinary
  // message. That degrade is deliberate: a `question_response` written with no
  // tool waiting would be skipped by kind and lost in silence.
  log(`ask_user_question (escalated) timeout: ${questionId}`);
  return err(
    `Your orchestrator did not answer within ${timeout / 1000}s. Do not ask again, a second question would ` +
      `wait behind the same silence. Either continue with the safest reading and say plainly which one you took, ` +
      `or report what you are blocked on and end your turn. A late answer will reach you as a new message.`,
  );
}

export const askUserQuestion: McpToolDefinition = {
  tool: {
    name: 'ask_user_question',
    description:
      'Ask the user a multiple-choice question and wait for their response. This is a blocking call — execution pauses until the user responds or the timeout expires. Provide a short card title (e.g. "Confirm deletion") and an array of options — each option may be a plain string (used as both button label and result value) or an object { label, selectedLabel?, value? } where selectedLabel is the text shown on the card after the user clicks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short card title shown above the question' },
        question: { type: 'string', description: 'The question to ask' },
        options: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  selectedLabel: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['label'],
              },
            ],
          },
          description: 'Options for the user to choose from (string or {label, selectedLabel?, value?})',
        },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 300)' },
      },
      required: ['title', 'question', 'options'],
    },
  },
  async handler(args) {
    const title = args.title as string;
    const question = args.question as string;
    const rawOptions = args.options as unknown[];
    if (!title || !question || !rawOptions?.length) {
      return err('title, question, and options are required');
    }

    const options = rawOptions.map((o) => {
      if (typeof o === 'string') return { label: o, selectedLabel: o, value: o };
      const obj = o as { label: string; selectedLabel?: string; value?: string };
      return {
        label: obj.label,
        selectedLabel: obj.selectedLabel ?? obj.label,
        value: obj.value ?? obj.label,
      };
    });

    const questionId = generateId();
    const r = routing();
    const escalated = isAgentLane(r);
    // `??`, not `||`: `timeout: 0` means "do not wait", and `0 || 600` turned
    // that into a ten-minute block. Non-numbers and negatives fall back rather
    // than producing a NaN deadline that never expires.
    const requested =
      typeof args.timeout === 'number' && Number.isFinite(args.timeout) && args.timeout >= 0 ? args.timeout : null;
    const timeout = (requested ?? (escalated ? ESCALATED_TIMEOUT_S : CHANNEL_TIMEOUT_S)) * 1000;

    return escalated
      ? askOrchestrator(questionId, title, question, options, r, timeout)
      : askHuman(questionId, title, question, options, r, timeout);
  },
};

export const sendCard: McpToolDefinition = {
  tool: {
    name: 'send_card',
    description: 'Send a structured card (interactive or display-only) to the current conversation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        card: {
          type: 'object',
          description: 'Card structure with title, description, and optional children/actions',
        },
        fallbackText: { type: 'string', description: 'Text fallback for platforms without card support' },
      },
      required: ['card'],
    },
  },
  async handler(args) {
    const card = args.card as Record<string, unknown>;
    if (!card) return err('card is required');

    const id = generateId();
    const r = routing();
    const fallbackText = (args.fallbackText as string) || '';
    // Same lane, same missing renderer: a card copied to an orchestrator is
    // rendered as `content.text`, which a card does not have, so it arrived as
    // an empty message. `fallbackText` is exactly what this case is for — and
    // when the caller supplied none, say so rather than send nothing at all.
    const escalated = isAgentLane(r);
    const text = fallbackText || 'A card was sent with no text fallback, so its contents cannot be shown here.';

    await writeMessageOut({
      id,
      kind: escalated ? 'chat' : 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify(escalated ? { text } : { type: 'card', card, fallbackText }),
    });

    log(`send_card: ${id}`);
    return ok(`Card sent (id: ${id})`);
  },
};

registerTools([askUserQuestion, sendCard]);
