/**
 * What the agent must never inherit from whatever launched the host.
 *
 * A container never saw any of this. A host process inherits its launcher's
 * environment, and during development the launcher is very often a terminal
 * inside Claude Code — which exports a session identity, a live control
 * socket back to that session, and an effort override. The runner hands
 * `{...process.env}` to the SDK, so all of it reaches the nested `claude`.
 *
 * Both failures are silent. The agent starts, answers, and is simply wrong
 * about which account it is or whose session it belongs to.
 */
import { describe, expect, it } from 'vitest';

import { resolveSpawnCwd, stripInheritedClaudeEnv } from './local-driver.js';

describe('stripInheritedClaudeEnv', () => {
  it('removes the launching Claude Code session identity', () => {
    // Observed on a real host launched from a Claude Code shell. The nested
    // agent then believed it was a CHILD of that session and reported a
    // 165,000-token window on a model whose id ends in [1m].
    const env = stripInheritedClaudeEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'sess-abc',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_BRIDGE_SESSION_ID: 'bridge-abc',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_AGENT: 'general-purpose',
      CLAUDE_CODE_EXECPATH: '/usr/local/bin/claude',
      CLAUDE_EFFORT: 'high',
      CLAUDE_PID: '1234',
      CLAUDE_JOB_DIR: '/tmp/job',
    });

    expect(Object.keys(env)).toEqual([]);
  });

  it('removes the control socket, which points back at the launching session', () => {
    const env = stripInheritedClaudeEnv({
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    });

    expect(env.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined();
    expect(env.CLAUDE_CODE_MESSAGING_TOKEN).toBeUndefined();
  });

  it('still removes the auth overrides an account switcher depends on being absent', () => {
    const env = stripInheritedClaudeEnv({
      ANTHROPIC_API_KEY: 'sk-ant-x',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-x',
    });

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('keeps CLAUDE_CONFIG_DIR, which is how claude-swap selects an account', () => {
    // Scrubbing this pins the agent to the default profile — the same failure
    // the auth scrub prevents, arrived at from the other direction.
    const env = stripInheritedClaudeEnv({ CLAUDE_CONFIG_DIR: '/Users/kien/.claude-work' });

    expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/kien/.claude-work');
  });

  it('leaves unrelated environment alone', () => {
    const env = stripInheritedClaudeEnv({ HOME: '/Users/kien', PATH: '/usr/bin', TZ: 'Asia/Singapore' });

    expect(env).toEqual({ HOME: '/Users/kien', PATH: '/usr/bin', TZ: 'Asia/Singapore' });
  });
});

/**
 * Which directory the agent stands in.
 *
 * Claude Code resolves project memory and project skills by walking UP from
 * cwd — proven, and it does NOT stop at a git repository root. So cwd decides
 * which repository's `CLAUDE.md` and `.claude/skills/` an agent loads, and it
 * is the only thing that decides it.
 *
 * `NANOCLAW_AGENT_DIR` used to serve as both cwd and the agent's state
 * directory. That conflation is why one agent could only ever work in one
 * repository: moving it into a repo would have moved its memory and telemetry
 * in there too.
 */
describe('resolveSpawnCwd', () => {
  it('defaults to the group folder, so an existing install is unaffected', () => {
    expect(resolveSpawnCwd({}, { NANOCLAW_AGENT_DIR: '/groups/cli-with-kien' })).toBe('/groups/cli-with-kien');
  });

  it('uses the project directory when one is set, leaving AGENT_DIR alone', () => {
    const rootEnv = { NANOCLAW_AGENT_DIR: '/groups/cli-with-kien' };
    const env = { NANOCLAW_PROJECT_DIR: '/worktrees/saber-feat-abc' };

    expect(resolveSpawnCwd(env, rootEnv)).toBe('/worktrees/saber-feat-abc');
    // The state directory must NOT follow cwd: memory and footer telemetry
    // stay with the agent, not with whatever repo it is visiting.
    expect(rootEnv.NANOCLAW_AGENT_DIR).toBe('/groups/cli-with-kien');
  });

  it('treats a whitespace-only override as unset rather than chdir-ing to nothing', () => {
    // An empty value reaching `spawn` would resolve cwd to the host's own
    // directory — the nanoclaw checkout — which is how the 11,618-token
    // CLAUDE.md leak got into every session in the first place.
    expect(resolveSpawnCwd({ NANOCLAW_PROJECT_DIR: '   ' }, { NANOCLAW_AGENT_DIR: '/groups/g' })).toBe('/groups/g');
  });
});
