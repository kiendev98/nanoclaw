/**
 * What the footer needs that only Claude knows.
 *
 * Separate from `claude.ts` so a test can reach these without loading the
 * agent SDK, and so `telemetry/` can stay free of provider vocabulary. Both
 * are registered on the telemetry seam by `claude.ts`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The rate-limit windows Claude reports, in render order, with their labels.
 *
 * `seven_day_opus` is a model name, which is why this list cannot live in
 * shared code.
 */
export const CLAUDE_RATE_LIMIT_WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ['five_hour', '5h'],
  ['seven_day', '7d'],
  ['seven_day_opus', '7d opus'],
  ['seven_day_sonnet', '7d sonnet'],
];

/**
 * Shorten an SDK model id for display: `claude-opus-4-5-20251101` → `opus-4-5`.
 *
 * Taken from `system:init` rather than from `container.json`. The config's
 * `model` is optional, so an install that never pins one would show no model
 * at all. Init always reports what the turn actually ran on.
 */
export function shortenClaudeModel(model: string): string {
  return model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-latest$/, '');
}

/**
 * The active subscription's organisation name, from Claude Code's own config.
 *
 * `CLAUDE_CONFIG_DIR` is read per call. Note that the file is `~/.claude.json`,
 * a SIBLING of `~/.claude`. See `docs/message-footer.md`.
 *
 * Returns null on anything unexpected. The footer drops the field rather than
 * failing a delivery over a cosmetic line.
 */
export function readClaudeAccountName(): string | null {
  const configDir = (process.env.CLAUDE_CONFIG_DIR ?? '').trim();
  const configPath = configDir ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json');

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      oauthAccount?: { organizationName?: unknown };
    };
    const name = parsed.oauthAccount?.organizationName;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    // No config file, unreadable, or not JSON.
    return null;
  }
}
