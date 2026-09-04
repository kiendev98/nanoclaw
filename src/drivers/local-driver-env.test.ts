/**
 * What the agent must never inherit from whatever launched the host.
 *
 * A container never saw any of this. Both failures are silent: the agent
 * starts, answers, and is wrong about which account it is or whose session it
 * belongs to. See `docs/local-driver.md`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { LocalSessionDriver, resolveSpawnCwd, stripInheritedClaudeEnv } from './local-driver.js';
import { FIXTURE_POLICY, fixtureSpec } from './spec-fixture.js';
import type { MountPolicy, SessionSpec } from './types.js';

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
 * cwd alone decides which repository's `CLAUDE.md` and `.claude/skills/` an
 * agent loads. It used to double as the state directory, which is why an agent
 * could only work in one repository. See `docs/local-driver.md`.
 */
describe('resolveSpawnCwd', () => {
  it('defaults to the group folder, so an existing install is unaffected', () => {
    expect(resolveSpawnCwd(undefined, { NANOCLAW_AGENT_DIR: '/groups/cli-with-kien' })).toBe('/groups/cli-with-kien');
  });

  it("uses the spec's cwd when one is set, leaving AGENT_DIR alone", () => {
    const rootEnv = { NANOCLAW_AGENT_DIR: '/groups/cli-with-kien' };

    expect(resolveSpawnCwd('/worktrees/saber-feat-abc', rootEnv)).toBe('/worktrees/saber-feat-abc');
    // The state directory must NOT follow cwd: memory and footer telemetry
    // stay with the agent, not with whatever repo it is visiting.
    expect(rootEnv.NANOCLAW_AGENT_DIR).toBe('/groups/cli-with-kien');
  });

  it('treats a whitespace-only cwd as unset rather than chdir-ing to nothing', () => {
    // An empty value reaching `spawn` would resolve cwd to the host's own
    // directory, the nanoclaw checkout. That is how the 11,618-token
    // CLAUDE.md leak got into every session in the first place.
    expect(resolveSpawnCwd('   ', { NANOCLAW_AGENT_DIR: '/groups/g' })).toBe('/groups/g');
  });
});

/**
 * Where an operator's `ncl` attach lands.
 *
 * The bug this pins was silent: the cwd came from `path.dirname` of the
 * session NAME, which carries no separator, so every attach landed in the
 * host's own directory regardless of session.
 */
describe('execSpec', () => {
  /** The fixture is rooted at `/install`; re-root it somewhere writable. */
  function rehome(root: string): { policy: MountPolicy; spec: SessionSpec } {
    const swap = (value: string): string => value.replace('/install', root);
    const spec = fixtureSpec();
    return {
      policy: {
        groupsRoot: swap(FIXTURE_POLICY.groupsRoot),
        dataRoot: swap(FIXTURE_POLICY.dataRoot),
        surfaceRoots: FIXTURE_POLICY.surfaceRoots.map(swap),
        materialsRoot: swap(FIXTURE_POLICY.materialsRoot),
      },
      spec: {
        ...spec,
        containers: spec.containers.map((c) => ({
          ...c,
          // The shared fixture carries no group mount; real composition always
          // does (`buildMounts`), and this driver refuses a spec without one.
          mounts: [
            ...c.mounts.map((m) => ({ ...m, hostPath: swap(m.hostPath) })),
            {
              class: 'group-state' as const,
              hostPath: path.join(root, 'groups', 'agent-one'),
              containerPath: '/workspace/agent',
              mode: 'rw' as const,
              groupScope: 'g1',
            },
          ],
        })),
      },
    };
  }

  it("attaches in the agent's working directory, not the host's", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-exec-'));
    const { policy, spec } = rehome(root);
    const driver = new LocalSessionDriver({
      policy,
      runnerEntry: path.join(process.cwd(), 'container', 'agent-runner', 'src', 'index.ts'),
    });

    const handle = await driver.prepare(spec);

    expect(handle.execSpec(['bash']).argsTty).toContain(path.join(root, 'groups', 'agent-one'));
  });
});
