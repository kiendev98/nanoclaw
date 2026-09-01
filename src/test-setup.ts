import { afterEach, beforeEach } from 'vitest';

/**
 * Environment prefixes stripped for the duration of every test.
 *
 * Tests that exercise channel wiring isolate the FILESYSTEM — a tmpdir, a
 * chdir, and their own `.env` — but `readEnvValue` (and `readEnvFile`, and the
 * adapter factories) consult `process.env` FIRST and fall back to the file. So
 * on a developer machine with real credentials exported, the live value wins
 * over the fixture and the isolation is silently void.
 *
 * That is not a cosmetic failure. `slack-agent-flow` went red with a live
 * `xoxb-…` token in the assertion diff, and `create_room` reached the real
 * Slack API and came back `invalid_auth` — a test run was making authenticated
 * calls as the operator's bot and printing its token into the output.
 *
 * Stripped rather than blanked: `readEnvValue` treats an empty value as absent
 * and falls through to the file, but not every reader is that careful, and an
 * absent key is the state a clean checkout actually has.
 */
const ISOLATED_ENV_PREFIXES = ['SLACK_', 'DISCORD_', 'TELEGRAM_', 'ANTHROPIC_', 'CLAUDE_CODE_OAUTH'] as const;

let savedEnv: Array<[string, string]> = [];

beforeEach(async () => {
  savedEnv = Object.entries(process.env)
    .filter(([key, value]) => value !== undefined && ISOLATED_ENV_PREFIXES.some((p) => key.startsWith(p)))
    .map(([key, value]) => [key, value as string]);
  for (const [key] of savedEnv) delete process.env[key];

  await import('./mailbox/compose.js');
});

afterEach(() => {
  // Restored so the suite leaves the process as it found it — a later run in
  // the same shell, and anything else sharing it, must not see a stripped
  // environment.
  for (const [key, value] of savedEnv) process.env[key] = value;
  savedEnv = [];
});
