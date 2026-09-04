/**
 * What the driver must remember, and what it must forget.
 *
 * Every case here spawns a real child, because all four bugs they pin lived in
 * the bookkeeping around a spawn rather than in the spawn itself, and none was
 * reachable from a build or from an assertion about a composed spec.
 *
 * The runtime is a two-line shell script, not `bun`. `#spawnRunner` invokes
 * `<runtimeBin> run <runnerEntry>`, so the stand-in drops the `run` and execs
 * the rest — which makes the runner any script this file wants to write.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { LocalSessionDriver } from './local-driver.js';
import { FIXTURE_POLICY, fixtureSpec } from './spec-fixture.js';
import type { MountPolicy, SessionSpec } from './types.js';

/** The fixture is rooted at `/install`; re-root it somewhere writable. */
function rehome(
  root: string,
  overrides: Partial<SessionSpec['containers'][number]> = {},
): { policy: MountPolicy; spec: SessionSpec } {
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
        ...overrides,
        // The shared fixture carries no group mount; real composition always
        // does, and this driver refuses a spec without one.
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

/**
 * A runtime whose only job is to run `body`.
 *
 * `shift` drops the `run` argument the driver passes, which is Bun's
 * subcommand and not one `/bin/sh` has.
 */
function fakeRuntime(root: string, body: string): { runtimeBin: string; runnerEntry: string } {
  const runtimeBin = path.join(root, 'fake-bun');
  const runnerEntry = path.join(root, 'runner.sh');
  fs.writeFileSync(runtimeBin, '#!/bin/sh\nshift\nexec /bin/sh "$@"\n', { mode: 0o755 });
  fs.writeFileSync(runnerEntry, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { runtimeBin, runnerEntry };
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the child to settle');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * A root with the group directory already on disk.
 *
 * The child's working directory IS that group directory, and `spawn` reports a
 * missing cwd as ENOENT against the binary — so omitting it here would test
 * the spawn-failure path while claiming to test the success one. Real
 * composition guarantees the directory exists.
 */
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-life-'));
  fs.mkdirSync(path.join(root, 'groups', 'agent-one'), { recursive: true });
  return root;
}

describe('prepare is idempotent on key', () => {
  it('hands back the running child instead of spawning a second runner', async () => {
    const root = tempRoot();
    const log = path.join(root, 'starts.log');
    const { policy, spec } = rehome(root);
    const { runtimeBin, runnerEntry } = fakeRuntime(root, `echo start >> ${log}\nsleep 5`);
    const driver = new LocalSessionDriver({ policy, runnerEntry, runtimeBin });

    const first = await driver.prepare(spec);
    await first.start();
    await waitUntil(() => fs.existsSync(log));

    // The second realization of the same key. Before this was idempotent it
    // spawned a second runner against the same mailbox databases, and
    // overwrote the first child so it could never be stopped through the
    // driver again.
    const second = await driver.prepare(spec);
    await second.start();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(fs.readFileSync(log, 'utf-8').trim().split('\n')).toHaveLength(1);
    expect((await second.status()).phase).toBe('running');

    await first.stop('test');
  });
});

describe('a remembered exit code never answers for a later run', () => {
  it('reports ready, not failed, after the same key is prepared again', async () => {
    const root = tempRoot();
    const { policy, spec } = rehome(root);
    const { runtimeBin, runnerEntry } = fakeRuntime(root, 'exit 3');
    const driver = new LocalSessionDriver({ policy, runnerEntry, runtimeBin });

    const first = await driver.prepare(spec);
    await first.start();
    await waitUntil(async () => (await first.status()).phase === 'failed');

    // `sessionName` is deterministic, so a woken session reuses the name, and
    // `status()` reads the exit map before any liveness check. One non-zero
    // exit used to report 'failed' for every later spawn of that session for
    // the life of the host process.
    const second = await driver.prepare(spec);

    expect((await second.status()).phase).toBe('ready');
  });
});

describe('a self-exited runner leaves no residue', () => {
  it('removes the record so the poll stops re-emitting terminal for it', async () => {
    const root = tempRoot();
    const { policy, spec } = rehome(root);
    const { runtimeBin, runnerEntry } = fakeRuntime(root, 'exit 0');
    const driver = new LocalSessionDriver({ policy, runnerEntry, runtimeBin });

    const handle = await driver.prepare(spec);
    const recordFile = path.join(root, 'data', 'local-sessions', 'spike', `${handle.name}.json`);
    await handle.start();
    await waitUntil(() => fs.existsSync(recordFile));
    await waitUntil(async () => (await handle.status()).phase === 'stopped');
    await waitUntil(() => !fs.existsSync(recordFile));

    expect(fs.existsSync(recordFile)).toBe(false);
    expect(await driver.listSessions('spike')).toEqual([]);
  });

  it('removes the extra/ symlink tree it planted', async () => {
    const root = tempRoot();
    const { policy, spec } = rehome(root);
    const { runtimeBin, runnerEntry } = fakeRuntime(root, 'exit 0');
    const driver = new LocalSessionDriver({ policy, runnerEntry, runtimeBin });

    const extras = path.join(root, 'data', 'local-sessions', 'spike', 'g1__s1');
    const handle = await driver.prepare(spec);

    expect(fs.existsSync(extras)).toBe(true);

    await handle.start();
    await waitUntil(() => !fs.existsSync(extras));

    expect(fs.existsSync(extras)).toBe(false);
  });
});

describe('the contributed credential lane survives the inherited-env scrub', () => {
  it('keeps a provider-contributed token and still drops the inherited one', async () => {
    const root = tempRoot();
    const dump = path.join(root, 'env.txt');
    const { policy, spec } = rehome(root, {
      // The pattern `types.ts` sanctions by name: a placeholder the OneCLI
      // proxy overwrites on the wire. Scrubbing the MERGED environment deleted
      // it, leaving the base URL with no Authorization header to rewrite.
      contributedEnv: { ANTHROPIC_AUTH_TOKEN: 'placeholder', ANTHROPIC_BASE_URL: 'http://127.0.0.1:10254' },
    });
    const { runtimeBin, runnerEntry } = fakeRuntime(root, `env > ${dump}`);
    const driver = new LocalSessionDriver({ policy, runnerEntry, runtimeBin });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-inherited-from-the-launching-shell';
    process.env.CLAUDECODE = '1';
    try {
      const handle = await driver.prepare(spec);
      await handle.start();
      await waitUntil(() => fs.existsSync(dump));
      await waitUntil(async () => (await handle.status()).phase !== 'running');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDECODE;
    }

    const env = fs.readFileSync(dump, 'utf-8');
    expect(env).toContain('ANTHROPIC_AUTH_TOKEN=placeholder');
    expect(env).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:10254');
    expect(env).not.toContain('ANTHROPIC_API_KEY');
    expect(env).not.toContain('CLAUDECODE=');
  });
});

describe('a spawn that fails fails the session, not the host', () => {
  it('reports the error instead of letting it become an uncaught exception', async () => {
    const root = tempRoot();
    const { policy, spec } = rehome(root);
    const { runnerEntry } = fakeRuntime(root, 'exit 0');
    const driver = new LocalSessionDriver({
      policy,
      runnerEntry,
      // Nothing at this path. `log.ts` answers an uncaught exception with
      // process.exit(1), so before the child carried an 'error' listener this
      // took down every other session on the host with it.
      runtimeBin: path.join(root, 'no-such-runtime'),
    });

    const handle = await driver.prepare(spec);

    // `start` reports it the way the seam prescribes — a retryable
    // runtime-unavailable, raised from the child having no pid. The listener's
    // job is not to change that; it is to stop the SAME failure arriving a
    // second time as an uncaught exception once the event loop turns.
    await expect(handle.start()).rejects.toThrow('runtime-unavailable');
    await waitUntil(() => driver.listSessions('spike').then((s) => s.length === 0));

    expect(await driver.listSessions('spike')).toEqual([]);
  });
});

describe('capabilities name the read-only reduction', () => {
  it('declares readonlyMounts false, because a mount here is the host directory', () => {
    const root = tempRoot();
    const { policy } = rehome(root);
    const driver = new LocalSessionDriver({
      policy,
      runnerEntry: path.join(process.cwd(), 'container', 'agent-runner', 'src', 'index.ts'),
    });

    expect(driver.capabilities().readonlyMounts).toBe(false);
  });
});
