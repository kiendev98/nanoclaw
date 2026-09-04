/**
 * The footer field, as it crosses the process boundary.
 *
 * The agent-runner writes `footer` beside `text` on the outbound content blob,
 * as its own field rather than glued to the body, so a channel that can style
 * it does — Slack renders a muted element as a small grey context block.
 *
 * `OutboundMessage.content` is `unknown` by design: the host does not own what
 * a provider puts in it. That leaves this field with no compiler to enforce
 * it, so the contract lives here instead, in one module both adapters call.
 *
 * An adapter that ignores this drops the footer silently. If you are writing
 * one: read the footer with `readFooter`, then either render it separately or
 * fall back to `appendFooter`. There is no third correct option.
 */

/** The outbound content shape this module knows about. Everything else is the provider's. */
export interface FooterCarrier {
  text?: unknown;
  footer?: unknown;
}

/** The footer on this content, trimmed, or empty when there is none. */
export function readFooter(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const footer = (content as FooterCarrier).footer;
  return typeof footer === 'string' ? footer.trim() : '';
}

/**
 * The body with its footer appended, for a channel with no way to style it.
 *
 * One blank line between them, in one place, because three copies of
 * `${body}\n\n${footer}` is three chances to drift.
 */
export function appendFooter(body: string, footer: string): string {
  return body && footer ? `${body}\n\n${footer}` : body;
}
