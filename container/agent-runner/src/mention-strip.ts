/**
 * Strip the leading channel mention off a message before it is read as a slash
 * command.
 *
 * WHY THIS EXISTS: Slack swallows a bare leading `/` — the client treats it as
 * its own slash command and never sends it — so a user who wants the agent to
 * see `/compact` has to tag the bot first. The text that arrives is therefore
 * `<@U123> /compact`, which fails the `text.startsWith('/')` test on both sides
 * of the wire. Every slash command was silently degrading to prose: `/compact`
 * and `/context` stopped acting on the session, and `/blueprint` arrived as a
 * sentence beginning with a mention.
 *
 * DUPLICATED ON PURPOSE. The host-side copy is `src/mention-strip.ts`, and the
 * two must stay identical. They cannot import one another: the host is compiled
 * by `tsc` with `rootDir: ./src` and this runner is a separate build unit run by
 * Bun with `rootDir: ./container/agent-runner/src`, so nothing crosses that
 * line — the mailbox model is copied through `npm run mailbox-model:generate`
 * for the same reason. Change one, change the other.
 */

/**
 * One or more leading Slack mentions, plus the whitespace and the single
 * punctuation mark ("@bot: /compact") that follow them.
 *
 * Handles both encodings Slack emits: `<@U123>` and the labelled
 * `<@U123|name>`. Anchored, so a mention anywhere but the front is left alone —
 * "tell <@U123> to stop" is prose, not an address.
 */
const LEADING_MENTIONS = /^(?:\s*<@[A-Za-z0-9_]+(?:\|[^>]*)?>\s*[,:]?)+\s*/;

/**
 * The message text with any leading mentions removed.
 *
 * Returns the input unchanged when it does not begin with a mention, so a
 * caller can apply this unconditionally before a command test.
 */
export function stripLeadingMentions(text: string): string {
  return text.replace(LEADING_MENTIONS, '');
}
