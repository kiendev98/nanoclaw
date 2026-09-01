/**
 * The one-line telemetry footer appended to delivered chat messages:
 *
 *   Wego #1 · opus-5 · ctx: 54% · 5h: 31% · 7d: 12%
 *
 * Every field is omitted when its source has not reported yet, so a fresh
 * session degrades to `opus-5` rather than printing zeros it cannot stand
 * behind. A footer that invents a number is worse than no footer.
 *
 * WHY THE ACCOUNT IS THE ORGANISATION, not the email. The two subscriptions
 * this runs against are the same login (`kien@wego.com`, one accountUuid) in
 * two different organisations. Email cannot tell them apart. The config
 * directory could, but it names claude-swap's plumbing rather than the thing
 * the reader is asking about — which subscription is this turn spending?
 *
 * WHY IT APPENDS TO EVERY MESSAGE rather than only the turn's last one. With
 * a provider that streams text (Claude), `dispatchResultText` runs with
 * `suppressDelivery`: every message is delivered mid-turn, as its block is
 * parsed, and the result door sends nothing. So at the moment the turn ends
 * there is no final row left to decorate — the rows are already written, and
 * the host may already have delivered them. Rewriting one after the fact is a
 * race against the outbound poller. The usual turn sends exactly one message,
 * where per-message and per-turn are the same thing.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Rate-limit windows worth showing, in render order, with their labels. */
const WINDOW_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['five_hour', '5h'],
  ['seven_day', '7d'],
  ['seven_day_opus', '7d opus'],
  ['seven_day_sonnet', '7d sonnet'],
];

/**
 * Utilization per `rateLimitType`, newest wins.
 *
 * The SDK emits `rate_limit_event` only when the value CHANGES, so this is a
 * running store rather than something read per turn. An entry that never
 * arrives stays absent and its field never renders.
 */
const utilizationByWindow = new Map<string, number>();

/** Tokens occupying the context window as of the last assistant message. */
let contextTokens: number | null = null;

/**
 * Context window for the model in use. Only the `result` message carries it
 * (`modelUsage[model].contextWindow`), so it lands one turn later than the
 * first token count — hence the two are stored separately and `ctx` renders
 * only once both exist.
 */
let contextWindow: number | null = null;

let accountLabel: string | null | undefined;

/** Model id from the SDK's `system:init`, already shortened for display. */
let modelLabel: string | null = null;

/**
 * Shorten an SDK model id for display: `claude-opus-4-5-20251101` → `opus-4-5`.
 *
 * Taken from `system:init` rather than from `container.json`, because the
 * config's `model` is optional — an install that never pins one would show no
 * model at all, while init always reports what the turn actually ran on.
 */
export function shortenModel(model: string): string {
  return model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-latest$/, '');
}

/** Record the model the current turn runs on, from `system:init`. */
export function recordModel(model: string | undefined): void {
  if (typeof model === 'string' && model.trim()) modelLabel = shortenModel(model.trim());
}

export interface FooterUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Record what an assistant message reports about window occupancy.
 *
 * Input plus both cache counters is what actually sits in the window; output
 * tokens are excluded because they are not resident until the next request
 * echoes them back as input.
 */
export function recordContextUsage(usage: FooterUsage | undefined): void {
  if (!usage) return;
  const total =
    (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  if (total > 0) contextTokens = total;
}

/** Record the model's context window, which only a `result` message carries. */
export function recordContextWindow(size: number | undefined): void {
  if (typeof size === 'number' && size > 0) contextWindow = size;
}

/** Record one window's utilization (0–1) from a `rate_limit_event`. */
export function recordUtilization(rateLimitType: string | undefined, utilization: number | undefined): void {
  if (!rateLimitType) return;
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return;
  utilizationByWindow.set(rateLimitType, utilization);
}

/**
 * The active subscription's organisation name.
 *
 * `CLAUDE_CONFIG_DIR` is read per call rather than captured at import,
 * because claude-swap sets it per process and this module may load before it
 * does. The resolved value is cached after the first successful read: the
 * organisation cannot change under a running session without the process
 * being replaced.
 *
 * When the variable is unset, the config file is `~/.claude.json` — a SIBLING
 * of `~/.claude`, not a file inside it. When it is set, the file lives inside
 * the named directory. Getting that wrong reads nothing and silently drops
 * the field.
 */
export function accountName(): string | null {
  if (accountLabel !== undefined) return accountLabel;

  const configDir = (process.env.CLAUDE_CONFIG_DIR ?? '').trim();
  const configPath = configDir
    ? path.join(configDir, '.claude.json')
    : path.join(os.homedir(), '.claude.json');

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      oauthAccount?: { organizationName?: unknown };
    };
    const name = parsed.oauthAccount?.organizationName;
    accountLabel = typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    // No config file, unreadable, or not JSON. The footer drops the field
    // rather than failing a delivery over a cosmetic line.
    accountLabel = null;
  }
  return accountLabel;
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
export function renderFooter(model: string | null = modelLabel): string | null {
  const parts: string[] = [];

  const account = accountName();
  if (account) parts.push(account);
  if (model) parts.push(model);

  if (contextTokens !== null && contextWindow !== null) {
    parts.push(`ctx: ${percent(Math.min(contextTokens / contextWindow, 1))}`);
  }

  for (const [key, label] of WINDOW_LABELS) {
    const value = utilizationByWindow.get(key);
    if (value !== undefined) parts.push(`${label}: ${percent(value)}`);
  }

  // One field is not a footer — a bare model name adds noise and no signal.
  if (parts.length < 2) return null;
  return parts.join(' · ');
}

/** Append the footer to a message body. Returns the body unchanged when there is nothing to say. */
export function withFooter(body: string): string {
  const footer = renderFooter();
  return footer ? `${body}\n\n${footer}` : body;
}

/** Test seam: drop every recorded value so a case starts from a known state. */
export function resetFooterTelemetry(): void {
  utilizationByWindow.clear();
  contextTokens = null;
  contextWindow = null;
  accountLabel = undefined;
  modelLabel = null;
}
