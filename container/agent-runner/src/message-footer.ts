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

import { randomUUID } from 'crypto';

import { getFooterTelemetry, setFooterTelemetry } from './db/session-state.js';
import { AGENT_DIR } from './roots.js';

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
 * Context percentage straight from the SDK's `getContextUsage()`, 0–100.
 *
 * Preferred over dividing tokens by `contextWindow`, and not a refinement:
 * Claude Code reserves part of the window for output, so its own `/context`
 * divides by `maxTokens` rather than the raw window. The computed ratio
 * therefore reads LOWER than what the user sees in their terminal, which is
 * the kind of near-miss that makes a reader distrust every other field.
 */
let contextPercent: number | null = null;

/** Organisation from the SDK's `accountInfo()`, preferred over reading the config file. */
let accountFromSdk: string | null = null;

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
  if (total === 0) return;
  load();
  contextTokens = total;
  persistSession();
}

/** Record the authoritative context percentage (0–100) from `getContextUsage()`. */
export function recordContextPercent(percentage: number | undefined): void {
  if (typeof percentage !== 'number' || !Number.isFinite(percentage)) return;
  load();
  contextPercent = Math.max(0, Math.min(percentage, 100));
  persistSession();
}

/** Record the organisation from `accountInfo()`. Wins over the config file. */
export function recordAccountName(organization: string | undefined): void {
  if (typeof organization !== 'string' || !organization.trim()) return;
  accountFromSdk = organization.trim();
}

/** Record the model's context window, which only a `result` message carries. */
export function recordContextWindow(size: number | undefined): void {
  if (typeof size !== 'number' || size <= 0) return;
  load();
  contextWindow = size;
  persistGroup();
}

/**
 * Record every window from the structured `/usage` payload.
 *
 * A second source for the same two fields, and in practice the only one that
 * has ever produced a value here: `rate_limit_event` fires only when a
 * utilization CHANGES, and across four sessions on this account it never
 * fired at all, leaving `windows` empty every time.
 *
 * The two sources disagree on units. `rate_limit_event.utilization` is a
 * fraction, this one is a PERCENTAGE (0–100), so it is divided here to keep
 * one convention in the store. Getting that wrong renders `5h: 3100%`.
 */
export function recordRateLimits(rateLimits: Record<string, { utilization?: number | null } | null> | undefined): void {
  if (!rateLimits || typeof rateLimits !== 'object') return;
  let changed = false;
  for (const [key, window] of Object.entries(rateLimits)) {
    const value = window?.utilization;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    load();
    utilizationByWindow.set(key, Math.max(0, Math.min(value / 100, 1)));
    changed = true;
  }
  if (changed) persistGroup();
}

/** Record one window's utilization (0–1) from a `rate_limit_event`. */
export function recordUtilization(rateLimitType: string | undefined, utilization: number | undefined): void {
  if (!rateLimitType) return;
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return;
  load();
  utilizationByWindow.set(rateLimitType, utilization);
  persistGroup();
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
  if (accountFromSdk) return accountFromSdk;
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

/**
 * Two stores, because the three facts have different lifetimes and only one
 * of them belongs to a session.
 *
 *   contextTokens  — this conversation's occupancy. Session-scoped. Sharing it
 *                    would show one thread's context inside another.
 *   contextWindow  — a property of the MODEL.
 *   windows        — utilization of the ACCOUNT's rate-limit windows.
 *
 * The last two were session-scoped in the first cut, and that is why a new
 * thread's first message rendered no `ctx`: a fresh session starts with an
 * empty blob, and the window size only arrives on that turn's result — after
 * the message has already been sent. Every new thread started blind.
 *
 * They now live in one file in the group folder, shared by every session of
 * the agent group, so a new thread inherits them immediately.
 */
const GROUP_FILE = '.footer-telemetry.json';

/**
 * Whether the persisted state has been read into this process yet.
 *
 * Load is lazy rather than at import: this module is imported by the poll
 * loop and by the provider, both of which can be evaluated before the
 * mailbox is started, and reading session state before then throws.
 */
let loaded = false;

interface SessionTelemetry {
  contextTokens?: number;
  contextPercent?: number;
}

interface GroupTelemetry {
  contextWindow?: number;
  windows?: Record<string, number>;
}

/**
 * Resolved per call, not captured at import.
 *
 * `roots.ts` reads its environment once at module load, and `bunfig.toml`
 * preloads the modules barrel — which pulls `roots.ts` in before any test
 * file runs. So a captured AGENT_DIR is always the container default under
 * test, pointing at a path no test can write. Reading the variable here keeps
 * the group store exercisable, and also picks up a driver that exports the
 * root after this module was first imported.
 */
function groupFilePath(): string {
  const dir = (process.env.NANOCLAW_AGENT_DIR ?? '').trim() || AGENT_DIR;
  return path.join(dir.replace(/\/+$/, ''), GROUP_FILE);
}

/**
 * Read both stores once per process.
 *
 * Every failure mode is swallowed to null-effect: no mailbox, no file, or a
 * blob written by an older shape. The footer is cosmetic, and a delivery must
 * never fail over it.
 */
function load(): void {
  if (loaded) return;
  loaded = true;

  try {
    const raw = getFooterTelemetry();
    if (raw) {
      const parsed = JSON.parse(raw) as SessionTelemetry;
      if (typeof parsed.contextTokens === 'number') contextTokens = parsed.contextTokens;
      if (typeof parsed.contextPercent === 'number') contextPercent = parsed.contextPercent;
    }
  } catch {
    // Unreadable session state — start blank rather than fail.
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(groupFilePath(), 'utf-8')) as GroupTelemetry;
    if (typeof parsed.contextWindow === 'number') contextWindow = parsed.contextWindow;
    for (const [key, value] of Object.entries(parsed.windows ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value)) utilizationByWindow.set(key, value);
    }
  } catch {
    // No group file yet, or unreadable.
  }
}

/** Write this session's own occupancy. Never throws: see `load`. */
function persistSession(): void {
  try {
    setFooterTelemetry(
      JSON.stringify({
        ...(contextTokens !== null ? { contextTokens } : {}),
        ...(contextPercent !== null ? { contextPercent } : {}),
      } satisfies SessionTelemetry),
    );
  } catch {
    // Storage unavailable. The value still applies for this process.
  }
}

/**
 * Write the group-shared facts.
 *
 * Written through a randomly-named temp file and a rename, because sessions
 * of one agent group run concurrently and each holds the whole blob: a
 * partial write seen by a sibling would drop a window it never observed
 * itself. `wx` refuses an existing path, so a collision fails rather than
 * following a symlink the agent could have planted — the group folder is
 * writable by the agent.
 */
function persistGroup(): void {
  const target = groupFilePath();
  const tmp = `${target}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        ...(contextWindow !== null ? { contextWindow } : {}),
        windows: Object.fromEntries(utilizationByWindow),
      } satisfies GroupTelemetry),
      { flag: 'wx' },
    );
    fs.renameSync(tmp, target);
  } catch {
    // Unwritable group folder. The values still apply for this process.
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The rename consumed it, or it was never created.
    }
  }
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
  load();
  const parts: string[] = [];

  const account = accountName();
  if (account) parts.push(account);
  if (model) parts.push(model);

  if (contextPercent !== null) {
    parts.push(`ctx: ${Math.round(contextPercent)}%`);
  } else if (contextTokens !== null && contextWindow !== null) {
    // Fallback only. Reads low against `/context` — see `contextPercent`.
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

/**
 * Append the footer to a message body, for channels that carry only text.
 *
 * Prefer emitting the footer as its OWN field where the channel can style it
 * (see `renderFooter`): Slack renders a muted text element as a context
 * block — small and grey — which is the whole point of separating it from
 * the body. This is the fallback for channels with no such affordance.
 */
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
  accountFromSdk = null;
  modelLabel = null;
  contextPercent = null;
  loaded = false;
}
