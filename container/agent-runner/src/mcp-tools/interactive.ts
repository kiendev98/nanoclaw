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
 * ends, so the transcript is never wiped by `freshSessionPerTask` and there is
 * no resume to arrange — the answer simply becomes this call's return value
 * and the model carries on mid-thought. The cost is a bound: nobody is
 * demonstrably waiting at the other end, and the host kills a container whose
 * heartbeat is 30 minutes stale.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { findQuestionResponse, findEscalatedAnswers, markCompleted } from '../db/messages-in.js';
import { getSessionRouting } from '../db/session-routing.js';
import {
  markAwaitingInbound,
  clearAwaitingInbound,
  markLateAnswerExpected,
  getCurrentInReplyTo,
} from '../db/session-state.js';
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
 * It also says the next message is taken as the answer, because it is. An
 * orchestrator that replies "ok, let me check with them" has spent the answer
 * on an acknowledgement and left the asker holding a "let me check" it cannot
 * act on.
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
    'Your next message to me is taken as the answer, so send the answer by itself — an acknowledgement would be consumed in its place.',
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

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = findQuestionResponse(questionId);
    if (response) {
      const parsed = JSON.parse(response.content);
      // Mark the response as completed via processing_ack (outbound.db)
      markCompleted([response.id]);
      log(`ask_user_question response: ${questionId} → ${parsed.selectedOption}`);
      return ok(parsed.selectedOption);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  log(`ask_user_question timeout: ${questionId}`);
  return err(`Question timed out after ${timeout / 1000}s`);
}

/** The text an inbound message carries, or '' when it carries none. */
function messageText(row: { content: string }): string {
  let text: unknown;
  try {
    text = (JSON.parse(row.content) as { text?: unknown }).text;
  } catch {
    text = row.content;
  }
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * The agent-lane path: hand the question to the orchestrator and wait.
 *
 * THIS TOOL CLAIMS ITS OWN ANSWER. The poll loop is told one abstract fact —
 * some tool is waiting — and holds its push for that tick. Finding the
 * message, deciding it qualifies, and acking it all happen here. That is the
 * same shape as `askHuman` above, which needs no poll-loop cooperation at all
 * because a `question_response` is a `system` row the loop already skips by
 * kind. An escalated answer is an ordinary `chat` row with no mark on it, so
 * the claim is what distinguishes it — through `processing_ack`, the one
 * ledger both sides already write.
 *
 * That is not a stylistic preference. An earlier revision had the poll loop
 * write the answer into a second state key for this tool to collect, and that
 * key was a mailbox with no proof its reader existed: a container SIGKILLed
 * mid-wait left the flag set, and the next ordinary message was then consumed
 * and acked into a slot nobody was polling. Destroyed, with no trace. Nothing
 * can be lost that way now — if this tool is gone, nobody claims the row and
 * the poll loop delivers it normally.
 *
 * FLAG BEFORE SEND, which is the opposite of what this used to do. The old
 * order existed because a flag left behind by a failed send would swallow the
 * orchestrator's next unrelated message for the key's full thirty-minute life
 * — a silent stall. The flag is refreshed every iteration now and expires in
 * seconds, so a failed send costs one poll tick, and flagging first closes the
 * window where the poller could push the answer at a model that is blocked
 * inside this call and cannot act on it.
 */
async function askOrchestrator(
  questionId: string,
  title: string,
  question: string,
  options: QuestionOption[],
  r: Routing,
  timeout: number,
): Promise<ToolResult> {
  // Captured BEFORE the send. An answer is necessarily later than the question
  // it answers, so anything already waiting is a second instruction the
  // orchestrator queued during this turn — not a reply to something it had not
  // yet seen.
  const askedAt = new Date().toISOString();
  markAwaitingInbound(questionId);

  try {
    await writeMessageOut({
      id: questionId,
      // Address the orchestrator SESSION that briefed this worker, not whichever
      // of its sessions spoke to the group most recently. `resolveTargetSession`
      // falls back to peer affinity without this, and destinations are
      // group-scoped — so a scheduled task or a second thread that messaged this
      // worker since the brief would take the question instead. That wrong
      // session may itself hold a thread binding, which would then surface the
      // question inside an unrelated human thread.
      in_reply_to: getCurrentInReplyTo(),
      // `chat`, not `chat-sdk`: on this lane it IS prose. Claiming a card no
      // renderer here can honour is what made the old failure invisible.
      kind: 'chat',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ text: renderEscalatedQuestion(title, question, options) }),
    });

    log(`ask_user_question (escalated): ${questionId} → "${question}" [${options.map((o) => o.value).join(', ')}]`);

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      // The first message carrying text wins. A text-less row — a file the
      // orchestrator sent while this was blocked — is skipped rather than
      // claimed, so it stays pending and reaches the model after this returns.
      const answer = findEscalatedAnswers(askedAt).find((m) => messageText(m) !== '');
      if (answer) {
        const text = messageText(answer);
        markCompleted([answer.id]);
        log(`ask_user_question answered by orchestrator: ${questionId} → ${text}`);
        return ok(text);
      }
      markAwaitingInbound(questionId);
      await sleep(POLL_INTERVAL_MS);
    }

    // The answer may still be coming, and it will arrive as a NEW batch —
    // which `freshSessionPerTask` would otherwise start by wiping this
    // transcript, leaving the model a bare "use option B" with no question in
    // front of it. Ask the next batch to keep it.
    markLateAnswerExpected();
    log(`ask_user_question (escalated) timeout: ${questionId}`);
    return err(
      `Your orchestrator did not answer within ${timeout / 1000}s. Do not ask again — a second question would ` +
        `wait behind the same silence. Either continue with the safest reading and say plainly which one you took, ` +
        `or report what you are blocked on and end your turn. A late answer will reach you as a new message.`,
    );
  } finally {
    // Give the lane back on EVERY exit, including a throwing send. Left set it
    // would withhold the poll loop's next push, though only for the seconds it
    // takes the flag to expire.
    clearAwaitingInbound();
  }
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
    const escalated = r.channel_type === 'agent' && Boolean(r.platform_id);
    const timeout = ((args.timeout as number) || (escalated ? ESCALATED_TIMEOUT_S : CHANNEL_TIMEOUT_S)) * 1000;

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
    const escalated = r.channel_type === 'agent' && Boolean(r.platform_id);
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
