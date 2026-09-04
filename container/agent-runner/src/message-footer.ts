/**
 * The one-line telemetry footer appended to delivered chat messages:
 *
 *   Wego #1 · opus-5[1m] · think: high · ctx: 84k · 5h: 31% · 7d: 12%
 *
 * Every field is omitted when its source has not reported yet. A footer that
 * invents a number is worse than no footer.
 *
 * See `docs/message-footer.md` for why ctx is a token count, why the account
 * is the organisation, and why every message carries a footer.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { randomUUID } from 'crypto';

import { getFooterTelemetry, setFooterTelemetry } from './db/session-state.js';

/**
 * The container default. Overridden per process by NANOCLAW_AGENT_DIR,
 * which the local driver sets and the reader below consults first.
 */
const AGENT_DIR = '/workspace/agent';

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

let accountLabel: string | null | undefined;

/** Model id from the SDK's `system:init`, already shortened for display. */
let modelLabel: string | null = null;

/** Organisation from the SDK's `accountInfo()`, preferred over reading the config file. */
let accountFromSdk: string | null = null;

/**
 * Reasoning effort, from `container.json`.
 *
 * This is what nanoclaw REQUESTED, not what the SDK confirmed. `system:init`
 * reports the model but says nothing about effort, so nothing can be read
 * back. An unset value therefore renders nothing. Guessing the SDK's default
 * is not an option, because this code does not know that number.
 */
let effortLabel: string | null = null;

/**
 * Shorten an SDK model id for display: `claude-opus-4-5-20251101` → `opus-4-5`.
 *
 * Taken from `system:init` rather than from `container.json`. The config's
 * `model` is optional, so an install that never pins one would show no model
 * at all. Init always reports what the turn actually ran on.
 */
export function shortenModel(model: string): string {
  return model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-latest$/, '');
}

/** Record the configured reasoning effort. Omitted entirely when unset. */
export function recordEffort(effort: string | undefined): void {
  if (typeof effort !== 'string' || !effort.trim()) return;
  effortLabel = effort.trim().toLowerCase();
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
 * Input plus both cache counters is what actually sits in the window. Output
 * tokens are excluded, because they are not resident until the next request
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

/** Record the organisation from `accountInfo()`. Wins over the config file. */
export function recordAccountName(organization: string | undefined): void {
  if (typeof organization !== 'string' || !organization.trim()) return;
  accountFromSdk = organization.trim();
}

/** Record the authoritative occupancy from `getContextUsage().totalTokens`. */
export function recordContextTokens(totalTokens: number | undefined): void {
  if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens <= 0) return;
  load();
  contextTokens = Math.round(totalTokens);
  persistSession();
}

/**
 * Record every window from the structured `/usage` payload.
 *
 * In practice the only source that has ever produced a value here. The two
 * sources disagree on units: this one is a PERCENTAGE, so it is divided to
 * keep one convention. Getting that wrong renders `5h: 3100%`.
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
 * `CLAUDE_CONFIG_DIR` is read per call, then cached. Note that the config file
 * is `~/.claude.json`, a SIBLING of `~/.claude`. See `docs/message-footer.md`.
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
 * Two stores, because the two facts have different lifetimes.
 * `contextTokens` is session-scoped. `windows` is account-wide and lives in the
 * group folder. See `docs/message-footer.md`.
 */
const GROUP_FILE = '.footer-telemetry.json';

/**
 * Whether the persisted state has been read into this process yet.
 *
 * Load is lazy rather than at import. The poll loop and the provider both
 * import this module, and both can be evaluated before the mailbox starts.
 * Reading session state before then throws.
 */
let loaded = false;

interface SessionTelemetry {
  contextTokens?: number;
}

interface GroupTelemetry {
  windows?: Record<string, number>;
}

/**
 * Resolved per call, not captured at import.
 *
 * A captured value would be the container default under test, pointing at a
 * path no test can write. Reading the variable here keeps the group store
 * exercisable, and picks up a driver that sets the root after first import.
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
    }
  } catch {
    // Unreadable session state — start blank rather than fail.
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(groupFilePath(), 'utf-8')) as GroupTelemetry;
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
    setFooterTelemetry(JSON.stringify({ contextTokens: contextTokens ?? undefined } satisfies SessionTelemetry));
  } catch {
    // Storage unavailable. The value still applies for this process.
  }
}

/**
 * Write the group-shared facts.
 *
 * Written through a temp file and a rename, because sessions of one group run
 * concurrently. `wx` refuses an existing path, so a planted symlink is never
 * followed. See `docs/message-footer.md`.
 */
function persistGroup(): void {
  const target = groupFilePath();
  const tmp = `${target}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(
      tmp,
      JSON.stringify({ windows: Object.fromEntries(utilizationByWindow) } satisfies GroupTelemetry),
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
export function renderFooter(model: string | null = modelLabel): string | null {
  load();
  const parts: string[] = [];

  const account = accountName();
  if (account) parts.push(account);
  if (model) parts.push(model);
  if (effortLabel) parts.push(`think: ${effortLabel}`);

  if (contextTokens !== null) parts.push(`ctx: ${formatTokens(contextTokens)}`);

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
 * Prefer emitting the footer as its OWN field where the channel can style it.
 * See `renderFooter`. Slack renders a muted text element as a context block,
 * small and grey, which is the point of separating it from the body. This is
 * the fallback for channels with no such affordance.
 */
export function withFooter(body: string): string {
  const footer = renderFooter();
  return footer ? `${body}\n\n${footer}` : body;
}

/** Test seam: drop every recorded value so a case starts from a known state. */
export function resetFooterTelemetry(): void {
  utilizationByWindow.clear();
  contextTokens = null;
  accountLabel = undefined;
  accountFromSdk = null;
  modelLabel = null;
  effortLabel = null;
  loaded = false;
}
