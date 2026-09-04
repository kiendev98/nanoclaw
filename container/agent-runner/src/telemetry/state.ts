/**
 * What the current turn knows about itself. Providers write, the footer reads.
 *
 * Every value is optional and every field is omitted when its source has not
 * reported. A footer that invents a number is worse than no footer.
 *
 * This module holds NO provider vocabulary. A provider names its own
 * rate-limit windows through `registerRateLimitWindows`, so a model id never
 * appears in shared code.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readGroupWindows, readSessionTokens, writeGroupWindows, writeSessionTokens } from './persistence.js';

const utilizationByWindow = new Map<string, number>();

let registeredWindows: ReadonlyArray<readonly [string, string]> = [];
let contextTokens: number | null = null;
let accountLabel: string | null | undefined;
let modelLabel: string | null = null;
let accountFromSdk: string | null = null;

/**
 * Reasoning effort, from `container.json`.
 *
 * This is what nanoclaw REQUESTED, not what the SDK confirmed. `system:init`
 * reports the model but says nothing about effort, so nothing can be read
 * back. An unset value renders nothing. Guessing the SDK's default is not an
 * option, because this code does not know that number.
 */
let effortLabel: string | null = null;

/**
 * Whether the persisted state has been read into this process yet.
 *
 * Lazy rather than at import. The poll loop and the provider both reach this
 * module, and both can be evaluated before the mailbox starts. Reading session
 * state before then throws.
 */
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  const tokens = readSessionTokens();
  if (tokens !== null) contextTokens = tokens;
  for (const [key, value] of Object.entries(readGroupWindows())) utilizationByWindow.set(key, value);
}

/**
 * Declare which rate-limit windows this provider has, and what to call them.
 *
 * The order given is the render order. A provider that reports no windows
 * registers none, and the footer prints none — no shared module has to know
 * that `seven_day_opus` is a Claude name.
 */
export function registerRateLimitWindows(windows: ReadonlyArray<readonly [string, string]>): void {
  registeredWindows = windows;
}

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
  writeSessionTokens(contextTokens);
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
  writeSessionTokens(contextTokens);
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
  if (changed) writeGroupWindows(Object.fromEntries(utilizationByWindow));
}

/** Record one window's utilization (0–1) from a `rate_limit_event`. */
export function recordUtilization(rateLimitType: string | undefined, utilization: number | undefined): void {
  if (!rateLimitType) return;
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return;
  load();
  utilizationByWindow.set(rateLimitType, utilization);
  writeGroupWindows(Object.fromEntries(utilizationByWindow));
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
  const configPath = configDir ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json');

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

export interface TelemetrySnapshot {
  account: string | null;
  model: string | null;
  effort: string | null;
  contextTokens: number | null;
  /** Registered windows that actually have a value, in render order. */
  windows: ReadonlyArray<readonly [string, number]>;
}

/** Everything the footer needs, read once so it cannot see a half-updated turn. */
export function telemetrySnapshot(): TelemetrySnapshot {
  load();
  const windows: Array<readonly [string, number]> = [];
  for (const [key, label] of registeredWindows) {
    const value = utilizationByWindow.get(key);
    if (value !== undefined) windows.push([label, value]);
  }
  return { account: accountName(), model: modelLabel, effort: effortLabel, contextTokens, windows };
}

/**
 * Test seam: drop every recorded value so a case starts from a known state.
 *
 * Registered windows survive. They are module wiring, declared once when the
 * provider is imported, not something a turn records — and a real process
 * restart re-runs that import.
 */
export function resetFooterTelemetry(): void {
  utilizationByWindow.clear();
  contextTokens = null;
  accountLabel = undefined;
  accountFromSdk = null;
  modelLabel = null;
  effortLabel = null;
  loaded = false;
}
