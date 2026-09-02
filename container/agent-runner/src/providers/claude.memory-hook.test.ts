import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The provider hands the memory hook to the SDK through `options.settings`.
// The failure this pins is the loud-then-silent one: registering the hook used
// to REWRITE the settings file under `claudeConfigDir()`, which is disposable
// only inside a container. Under the local driver `HOME` is the operator's, so
// that file is their real `~/.claude/settings.json` — reformatted on every
// service restart, and left carrying a SessionStart entry that failed in every
// session they started, agent or not.

let lastOptions: Record<string, unknown> | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: Record<string, unknown> }) => {
    lastOptions = args.options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-mem' };
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let configDir: string;
let previousConfigDir: string | undefined;
let settingsFile: string;

beforeEach(() => {
  lastOptions = undefined;
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-hook-'));
  settingsFile = path.join(configDir, 'settings.json');
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

async function drive(): Promise<void> {
  const provider = new ClaudeProvider();
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: configDir });
  for await (const _ of q.events) {
    /* drain */
  }
}

describe('memory SessionStart delivery', () => {
  it('sends the hook to the SDK as a settings-layer command', async () => {
    await drive();

    expect((lastOptions?.settings as Record<string, unknown>).hooks).toEqual({
      SessionStart: [
        {
          matcher: 'startup|clear|compact',
          hooks: [{ type: 'command', command: MEMORY_SESSION_HOOK.command, timeout: 10 }],
        },
      ],
    });
  });

  it('writes no settings file of its own', async () => {
    await drive();

    expect(fs.existsSync(settingsFile)).toBe(false);
  });
});

describe('memory SessionStart cleanup', () => {
  it('removes entries an earlier version wrote, leaving every other hook intact', () => {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        customValue: 'preserved',
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'custom-stop' }] }],
          SessionStart: [
            { matcher: 'resume', hooks: [{ type: 'command', command: 'custom-resume' }] },
            {
              matcher: 'startup|clear|compact',
              hooks: [
                { type: 'command', command: 'bun /app/src/memory/hook.ts', timeout: 10 },
                { type: 'command', command: 'custom-start' },
              ],
            },
            { matcher: '.*', hooks: [{ type: 'command', command: 'bun /app/src/memory-hook.ts' }] },
          ],
        },
      }),
    );

    new ClaudeProvider().registerMemorySessionHook(MEMORY_SESSION_HOOK);

    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(settings.customValue).toBe('preserved');
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'custom-stop' }] }]);
    expect(settings.hooks.SessionStart).toEqual([
      { matcher: 'resume', hooks: [{ type: 'command', command: 'custom-resume' }] },
      { matcher: 'startup|clear|compact', hooks: [{ type: 'command', command: 'custom-start' }] },
    ]);
  });

  it('drops the SessionStart key when nothing else used it', () => {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|clear|compact',
              hooks: [{ type: 'command', command: 'bun /app/src/memory/hook.ts', timeout: 10 }],
            },
          ],
        },
      }),
    );

    new ClaudeProvider().registerMemorySessionHook(MEMORY_SESSION_HOOK);

    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))).toEqual({ hooks: {} });
  });

  // The operator's settings file is theirs, and under the local driver it is
  // also a file in a git checkout. Rewriting it to change nothing is how a
  // service restart came to show up as an unexplained diff.
  it('leaves a settings file it has nothing to remove from byte-identical', () => {
    const original = '{\n\t"hooks": {\n\n\t\t"Stop": [{"hooks":[{"type":"command","command":"custom"}]}]\n\t}\n}';
    fs.writeFileSync(settingsFile, original);

    new ClaudeProvider().registerMemorySessionHook(MEMORY_SESSION_HOOK);

    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(original);
  });

  it('creates no settings file where none existed', () => {
    new ClaudeProvider().registerMemorySessionHook(MEMORY_SESSION_HOOK);

    expect(fs.existsSync(settingsFile)).toBe(false);
  });
});
