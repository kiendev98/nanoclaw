/**
 * The telemetry footer. Every case here is about NOT printing a number the
 * runner cannot stand behind — a plausible-looking wrong percentage is worse
 * than a missing field, because the reader acts on it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import {
  accountName,
  recordAccountName,
  recordContextPercent,
  recordContextUsage,
  recordContextWindow,
  recordEffort,
  recordRateLimits,
  recordModel,
  recordUtilization,
  renderFooter,
  resetFooterTelemetry,
  shortenModel,
  withFooter,
} from './message-footer.js';

let configDir: string;
let previousConfigDir: string | undefined;
let groupDir: string;
let previousGroupDir: string | undefined;

/** Write a config file shaped like the real one, in the layout CLAUDE_CONFIG_DIR implies. */
function writeConfig(organizationName: unknown): void {
  fs.writeFileSync(
    path.join(configDir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'kien@wego.com', organizationName } }),
  );
}

beforeEach(() => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  previousGroupDir = process.env.NANOCLAW_AGENT_DIR;
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-footer-'));
  // The group store is a file in the agent group folder. Without a writable
  // root here it silently no-ops, and every group-scope case would pass for
  // the wrong reason.
  groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-footer-group-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  process.env.NANOCLAW_AGENT_DIR = groupDir;
  resetFooterTelemetry();
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  if (previousGroupDir === undefined) delete process.env.NANOCLAW_AGENT_DIR;
  else process.env.NANOCLAW_AGENT_DIR = previousGroupDir;
  resetFooterTelemetry();
});

describe('accountName', () => {
  // The two subscriptions share one login and one accountUuid, so the
  // organisation is the ONLY field that separates them. A change here stops
  // the footer distinguishing which subscription a turn spent.
  it('reads organizationName from the configured directory', () => {
    writeConfig('Wego #1');
    expect(accountName()).toBe('Wego #1');
  });

  it('follows CLAUDE_CONFIG_DIR, which is what claude-swap changes', () => {
    writeConfig('Wego #2');
    expect(accountName()).toBe('Wego #2');
  });

  it('returns null when the config file is absent', () => {
    expect(accountName()).toBeNull();
  });

  it('returns null when the file is not JSON, rather than throwing into a delivery', () => {
    fs.writeFileSync(path.join(configDir, '.claude.json'), 'not json at all');
    expect(accountName()).toBeNull();
  });

  it('returns null when organizationName is missing or blank', () => {
    writeConfig('   ');
    expect(accountName()).toBeNull();
  });
});

describe('shortenModel', () => {
  it('strips the vendor prefix and a trailing date stamp', () => {
    expect(shortenModel('claude-opus-4-5-20251101')).toBe('opus-4-5');
  });

  it('leaves an already-short id alone', () => {
    expect(shortenModel('claude-opus-5')).toBe('opus-5');
  });
});

describe('renderFooter', () => {
  it('renders every field once each source has reported', () => {
    writeConfig('Wego #1');
    recordModel('claude-opus-5');
    recordContextUsage({ input_tokens: 1_000, cache_read_input_tokens: 107_000 });
    recordContextWindow(200_000);
    recordUtilization('five_hour', 0.31);
    recordUtilization('seven_day', 0.12);

    expect(renderFooter()).toBe('Wego #1 · opus-5 · ctx: 54% · 5h: 31% · 7d: 12%');
  });

  it('omits ctx until BOTH the token count and the window are known', () => {
    writeConfig('Wego #1');
    recordModel('claude-opus-5');
    recordContextUsage({ input_tokens: 108_000 });

    // The window only arrives on a result, one message later than the first
    // token count. Dividing by a guessed window is the failure this prevents.
    expect(renderFooter()).toBe('Wego #1 · opus-5');
    recordContextWindow(200_000);
    expect(renderFooter()).toBe('Wego #1 · opus-5 · ctx: 54%');
  });

  it('omits a window that has never reported instead of printing 0%', () => {
    writeConfig('Wego #1');
    recordModel('claude-opus-5');
    recordUtilization('five_hour', 0.31);

    expect(renderFooter()).toBe('Wego #1 · opus-5 · 5h: 31%');
  });

  it('keeps the newest value for a window', () => {
    writeConfig('Wego #1');
    recordUtilization('five_hour', 0.31);
    recordUtilization('five_hour', 0.42);

    expect(renderFooter()).toBe('Wego #1 · 5h: 42%');
  });

  it('ignores a non-finite utilization', () => {
    writeConfig('Wego #1');
    recordModel('claude-opus-5');
    recordUtilization('five_hour', Number.NaN);

    expect(renderFooter()).toBe('Wego #1 · opus-5');
  });

  it('counts input plus both cache counters as resident context', () => {
    writeConfig('Wego #1');
    recordContextUsage({ input_tokens: 10_000, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 5_000 });
    recordContextWindow(100_000);

    expect(renderFooter()).toBe('Wego #1 · ctx: 20%');
  });

  it('clamps a context ratio above one rather than reporting 143%', () => {
    writeConfig('Wego #1');
    recordContextUsage({ input_tokens: 300_000 });
    recordContextWindow(200_000);

    expect(renderFooter()).toBe('Wego #1 · ctx: 100%');
  });

  it('returns null when only one field is known', () => {
    // A bare model name is noise: it tells the reader nothing they cannot see
    // from the bot itself.
    recordModel('claude-opus-5');
    expect(renderFooter()).toBeNull();
  });

  it('returns null when nothing has been recorded', () => {
    expect(renderFooter()).toBeNull();
  });
});

describe('withFooter', () => {
  it('separates the footer from the body by a blank line', () => {
    writeConfig('Wego #1');
    recordModel('claude-opus-5');

    expect(withFooter('done')).toBe('done\n\nWego #1 · opus-5');
  });

  it('leaves the body untouched when there is no footer, adding no trailing blank lines', () => {
    expect(withFooter('done')).toBe('done');
  });
});

/**
 * The reason the blob is persisted at all.
 *
 * Sessions are swept whenever they go idle, and the numbers arrive far more
 * rarely than they are read: `contextWindow` once per turn on the result, and
 * a utilization only when it CHANGES, which can be many turns apart. Held in
 * memory alone, every wake starts blank and the footer decays to a bare model
 * name until the SDK happens to mention them again — which is exactly what a
 * reader would report as "the data is wrong".
 */
describe('surviving a session sweep', () => {
  beforeEach(() => {
    initTestSessionDb();
  });

  afterEach(() => {
    closeSessionDb();
  });

  it('reloads context and utilization recorded before the process exited', () => {
    writeConfig('Wego #1');
    recordContextUsage({ input_tokens: 108_000 });
    recordContextWindow(200_000);
    recordUtilization('five_hour', 0.31);
    recordUtilization('seven_day', 0.12);
    expect(renderFooter()).toBe('Wego #1 · ctx: 54% · 5h: 31% · 7d: 12%');

    // The process restarts: in-memory state is gone, the stores are not.
    resetFooterTelemetry();
    writeConfig('Wego #1');

    expect(renderFooter()).toBe('Wego #1 · ctx: 54% · 5h: 31% · 7d: 12%');
  });

  it('keeps a reloaded window when a later event reports only the other one', () => {
    writeConfig('Wego #1');
    recordUtilization('five_hour', 0.31);
    recordUtilization('seven_day', 0.12);

    resetFooterTelemetry();
    writeConfig('Wego #1');
    // Only the 5h window changed after the wake. The 7d value must not vanish
    // merely because this session never heard about it.
    recordUtilization('five_hour', 0.44);

    expect(renderFooter()).toBe('Wego #1 · 5h: 44% · 7d: 12%');
  });

  // The bug this scoping fixes. A new thread is a NEW session with an empty
  // session store, and the window size only arrives on that turn's result —
  // after the first message is already sent. Held per session, every new
  // thread rendered its first message with no ctx at all.
  it('gives a brand-new session the model and account facts from the group', () => {
    writeConfig('Wego #1');
    recordContextWindow(200_000);
    recordUtilization('five_hour', 0.31);

    // A new thread: fresh session database, same agent group.
    closeSessionDb();
    resetFooterTelemetry();
    initTestSessionDb();
    writeConfig('Wego #1');

    // Its own occupancy is correctly absent — that IS session state — but the
    // window size and the account's utilization carry over, so the very first
    // message can render them.
    recordContextUsage({ input_tokens: 20_000 });
    expect(renderFooter()).toBe('Wego #1 · ctx: 10% · 5h: 31%');
  });

  it('does not leak one session\'s occupancy into another', () => {
    writeConfig('Wego #1');
    recordContextUsage({ input_tokens: 180_000 });
    recordContextWindow(200_000);
    expect(renderFooter()).toBe('Wego #1 · ctx: 90%');

    closeSessionDb();
    resetFooterTelemetry();
    initTestSessionDb();
    writeConfig('Wego #1');

    // 90% belonged to the other thread. Showing it here would be a lie the
    // reader would act on. The window size still carries over from the group
    // store, but with no occupancy to divide there is no ctx to render — and
    // the account alone is one field, which renders nothing.
    expect(renderFooter()).toBeNull();
  });
});

/**
 * The SDK's own answers, preferred over anything derived here.
 *
 * `getContextUsage()` is what `/context` prints, and it divides by the USABLE
 * window — Claude Code reserves part of the window for output. Computing the
 * ratio from the raw window reads LOWER than the number the user sees in a
 * terminal, which is the kind of near-miss that makes a reader distrust every
 * other field in the line.
 */
describe('authoritative SDK sources', () => {
  it('prefers the reported percentage over the computed ratio', () => {
    writeConfig('Wego #1');
    // The raw window says 10%. The SDK, dividing by the usable window, says 14.
    recordContextUsage({ input_tokens: 20_000 });
    recordContextWindow(200_000);
    expect(renderFooter()).toBe('Wego #1 · ctx: 10%');

    recordContextPercent(14);
    expect(renderFooter()).toBe('Wego #1 · ctx: 14%');
  });

  it('falls back to the computed ratio when the SDK never answered', () => {
    // getContextUsage is fire-and-forget, so a failed or slow control request
    // must still leave a ctx figure rather than a gap.
    writeConfig('Wego #1');
    recordContextUsage({ input_tokens: 20_000 });
    recordContextWindow(200_000);
    expect(renderFooter()).toBe('Wego #1 · ctx: 10%');
  });

  it('clamps a percentage outside 0–100', () => {
    writeConfig('Wego #1');
    recordContextPercent(140);
    expect(renderFooter()).toBe('Wego #1 · ctx: 100%');
  });

  it('ignores a non-finite percentage', () => {
    writeConfig('Wego #1');
    recordModel('claude-opus-5');
    recordContextPercent(Number.NaN);
    expect(renderFooter()).toBe('Wego #1 · opus-5');
  });

  it('prefers the organisation the SDK reports over the config file', () => {
    // claude-swap changes CLAUDE_CONFIG_DIR, but the SDK reports the account
    // the turn actually authenticated as — which is the question being asked.
    writeConfig('Wego #1');
    recordAccountName('Wego #2');
    recordModel('claude-opus-5');
    expect(renderFooter()).toBe('Wego #2 · opus-5');
  });

  it('keeps the config-file organisation when the SDK reports none', () => {
    writeConfig('Wego #1');
    recordAccountName(undefined);
    recordModel('claude-opus-5');
    expect(renderFooter()).toBe('Wego #1 · opus-5');
  });
});

/**
 * The structured `/usage` payload. In practice the only source that has ever
 * produced a 5h/7d value here — `rate_limit_event` fires solely on CHANGE and
 * never fired at all across four sessions on this account.
 */
describe('recordRateLimits', () => {
  it('converts percentages to the fraction the store keeps', () => {
    // This payload is 0-100 while rate_limit_event is 0-1. Skipping the
    // division renders `5h: 3100%`.
    writeConfig('Wego #1');
    recordRateLimits({ five_hour: { utilization: 31 }, seven_day: { utilization: 12 } });

    expect(renderFooter()).toBe('Wego #1 · 5h: 31% · 7d: 12%');
  });

  it('skips a window whose utilization is null', () => {
    writeConfig('Wego #1');
    recordModel('claude-opus-5');
    recordRateLimits({ five_hour: { utilization: null }, seven_day: null });

    expect(renderFooter()).toBe('Wego #1 · opus-5');
  });

  it('ignores a payload that is absent or not an object', () => {
    writeConfig('Wego #1');
    recordModel('claude-opus-5');
    recordRateLimits(undefined);

    expect(renderFooter()).toBe('Wego #1 · opus-5');
  });

  it('renders the per-model weekly windows it also carries', () => {
    writeConfig('Wego #1');
    recordRateLimits({ seven_day_opus: { utilization: 44 } });

    expect(renderFooter()).toBe('Wego #1 · 7d opus: 44%');
  });
});

describe('reasoning effort', () => {
  it('renders after the model', () => {
    writeConfig('Wego #1');
    recordModel('claude-opus-5');
    recordEffort('high');
    recordContextPercent(51);

    expect(renderFooter()).toBe('Wego #1 · opus-5 · think: high · ctx: 51%');
  });

  it('is omitted when container.json pins none', () => {
    // The SDK's `system:init` reports the model but not the effort, so an
    // unset value has nothing to read back. Printing a guessed default would
    // claim knowledge this code does not have.
    writeConfig('Wego #1');
    recordModel('claude-opus-5');
    recordEffort(undefined);

    expect(renderFooter()).toBe('Wego #1 · opus-5');
  });

  it('normalises case so the line reads consistently', () => {
    writeConfig('Wego #1');
    recordModel('claude-opus-5');
    recordEffort('  HIGH  ');

    expect(renderFooter()).toBe('Wego #1 · opus-5 · think: high');
  });
});
