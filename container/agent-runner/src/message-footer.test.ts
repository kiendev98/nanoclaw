/**
 * The telemetry footer. Every case here is about NOT printing a number the
 * runner cannot stand behind — a plausible-looking wrong percentage is worse
 * than a missing field, because the reader acts on it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  accountName,
  recordContextUsage,
  recordContextWindow,
  recordModel,
  recordUtilization,
  renderFooter,
  resetFooterTelemetry,
  shortenModel,
  withFooter,
} from './message-footer.js';

let configDir: string;
let previousConfigDir: string | undefined;

/** Write a config file shaped like the real one, in the layout CLAUDE_CONFIG_DIR implies. */
function writeConfig(organizationName: unknown): void {
  fs.writeFileSync(
    path.join(configDir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'kien@wego.com', organizationName } }),
  );
}

beforeEach(() => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-footer-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  resetFooterTelemetry();
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
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
