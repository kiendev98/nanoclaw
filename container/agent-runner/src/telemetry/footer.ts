/**
 * The one-line telemetry footer appended to delivered chat messages:
 *
 *   Wego #1 · opus-5[1m] · think: high · ctx: 84k · 5h: 31% · 7d: 12%
 *
 * Rendering only. Every value comes from `state.ts`, which providers write.
 *
 * See `docs/message-footer.md` for why ctx is a token count, why the account
 * is the organisation, and why every message carries a footer.
 */
import { telemetrySnapshot } from './state.js';

/**
 * Compact token count: `84313` → `84k`.
 *
 * Rounded to whole thousands because the figure moves by hundreds between
 * turns and the extra digits carry no decision. Below 1000 it renders as-is
 * rather than `0k`.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  return `${Math.round(tokens / 1000)}k`;
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * Render the footer, or null when nothing is known worth printing.
 *
 * Returning null rather than an empty string keeps the caller's decision
 * explicit: a message with no telemetry gets no trailing blank lines.
 */
export function renderFooter(modelOverride?: string | null): string | null {
  const telemetry = telemetrySnapshot();
  const model = modelOverride === undefined ? telemetry.model : modelOverride;
  const parts: string[] = [];

  if (telemetry.account) parts.push(telemetry.account);
  if (model) parts.push(model);
  if (telemetry.effort) parts.push(`think: ${telemetry.effort}`);
  if (telemetry.contextTokens !== null) parts.push(`ctx: ${formatTokens(telemetry.contextTokens)}`);
  for (const [label, value] of telemetry.windows) parts.push(`${label}: ${percent(value)}`);

  // One field is not a footer — a bare model name adds noise and no signal.
  if (parts.length < 2) return null;
  return parts.join(' · ');
}

/**
 * Append the footer to a message body, for channels that carry only text.
 *
 * Prefer emitting the footer as its OWN field where the channel can style it.
 * See `renderFooter`. Slack renders a muted text element as a context block,
 * small and grey, which is the point of separating it from the body. This is
 * the fallback for channels with no such affordance.
 */
export function withFooter(body: string): string {
  const footer = renderFooter();
  return footer ? `${body}\n\n${footer}` : body;
}
