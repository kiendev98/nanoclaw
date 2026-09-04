import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'bun:test';

const ROOT_VARS = [
  'NANOCLAW_SESSION_DIR',
  'NANOCLAW_AGENT_DIR',
  'NANOCLAW_EXTRA_DIR',
  'NANOCLAW_SESSION_CONTEXT_PATH',
] as const;

/**
 * `roots.ts` reads its environment once at module load, so each case
 * re-imports under a distinct query string to defeat the module cache.
 * Setting a variable and calling again would read the value captured by the
 * first import.
 */
async function loadRoots(overrides: Partial<Record<(typeof ROOT_VARS)[number], string>>, tag: string) {
  const previous = new Map(ROOT_VARS.map((k) => [k, process.env[k]]));
  for (const key of ROOT_VARS) delete process.env[key];
  Object.assign(process.env, overrides);
  try {
    return (await import(`./roots.js?case=${tag}`)) as typeof import('./roots.js');
  } finally {
    for (const key of ROOT_VARS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('roots', () => {
  // The container path is the default path. A change to any expectation in
  // this block is a behaviour change inside every existing container, not a
  // refactor — the whole point of these variables is that they are inert when
  // unset, so a container computes exactly what it computed before the module
  // existed.
  it('leaves every container path untouched when nothing is set', async () => {
    const r = await loadRoots({}, 'unset');

    expect(r.WORKSPACE_DIR).toBe('/workspace');
    expect(r.AGENT_DIR).toBe('/workspace/agent');
    expect(r.EXTRA_DIR).toBe('/workspace/extra');
    expect(r.OUTBOX_DIR).toBe('/workspace/outbox');
    expect(r.SESSION_CONTEXT_PATH).toBe('/app/.nanoclaw-session.json');
    expect(r.IS_HOSTED).toBe(false);
  });

  it('treats an empty or whitespace value as unset', async () => {
    const r = await loadRoots({ NANOCLAW_AGENT_DIR: '   ', NANOCLAW_SESSION_DIR: '' }, 'blank');

    expect(r.AGENT_DIR).toBe('/workspace/agent');
    expect(r.WORKSPACE_DIR).toBe('/workspace');
    expect(r.IS_HOSTED).toBe(false);
  });

  // The overlap that motivates one variable per root: in a container these two
  // are nested, on a host they are unrelated directories. Neither may be
  // derived from the other.
  it('lets the workspace and the agent directory be unrelated host paths', async () => {
    const r = await loadRoots(
      { NANOCLAW_SESSION_DIR: '/state/sessions/s1', NANOCLAW_AGENT_DIR: '/state/groups/dm' },
      'split',
    );

    expect(r.WORKSPACE_DIR).toBe('/state/sessions/s1');
    expect(r.AGENT_DIR).toBe('/state/groups/dm');
    expect(r.IS_HOSTED).toBe(true);
  });

  // The outbox lives inside the workspace unless it is named, so a driver that
  // relocates only the workspace still gets a coherent tree.
  it('derives the outbox from the workspace when it is not named', async () => {
    const r = await loadRoots({ NANOCLAW_SESSION_DIR: '/state/sessions/s1' }, 'derived-outbox');

    expect(r.OUTBOX_DIR).toBe('/state/sessions/s1/outbox');
  });

  // A driver builds these with path.join, and a stray trailing separator would
  // otherwise reach every consumer as a doubled slash — which compares unequal
  // to the same path without it, so anything keyed on the string would miss.
  it('strips trailing separators', async () => {
    const r = await loadRoots({ NANOCLAW_AGENT_DIR: '/state/groups/dm///' }, 'trailing');

    expect(r.AGENT_DIR).toBe('/state/groups/dm');
  });
});

describe('worktreeDir', () => {
  const VAR = 'NANOCLAW_WORKTREE_DIR';

  function withVar<T>(value: string | undefined, run: () => T): T {
    const previous = process.env[VAR];
    if (value === undefined) delete process.env[VAR];
    else process.env[VAR] = value;
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env[VAR];
      else process.env[VAR] = previous;
    }
  }

  // The absent case is every ordinary session, and it has to stay absent: the
  // caller then keeps AGENT_DIR, so nothing about a chat session changes.
  it('is null when no working copy is named or mounted', async () => {
    const r = await import('./roots.js');

    withVar(undefined, () => expect(r.worktreeDir()).toBeNull());
  });

  it('is null when the named directory does not exist', async () => {
    const r = await import('./roots.js');

    withVar('/nanoclaw-no-such-worktree', () => expect(r.worktreeDir()).toBeNull());
  });

  it('is the named directory when it exists', async () => {
    const r = await import('./roots.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-worktree-'));

    try {
      withVar(dir, () => expect(r.worktreeDir()).toBe(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
