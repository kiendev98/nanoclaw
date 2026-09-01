import { describe, expect, it } from 'bun:test';

/**
 * `roots.ts` reads the prefix once at module load, so each case re-imports the
 * module under a distinct query string to defeat the module cache. Setting the
 * variable and calling again would read the value captured by the first import.
 */
async function loadRoots(prefix: string | undefined, tag: string) {
  const previous = process.env.NANOCLAW_FS_PREFIX;
  if (prefix === undefined) delete process.env.NANOCLAW_FS_PREFIX;
  else process.env.NANOCLAW_FS_PREFIX = prefix;
  try {
    return (await import(`./roots.js?case=${tag}`)) as typeof import('./roots.js');
  } finally {
    if (previous === undefined) delete process.env.NANOCLAW_FS_PREFIX;
    else process.env.NANOCLAW_FS_PREFIX = previous;
  }
}

describe('roots', () => {
  // The container path is the default path. A change to any expectation in
  // this block is a behaviour change inside every existing container, not a
  // refactor — the whole point of the prefix is that it is inert when unset.
  it('leaves every container path untouched when no prefix is set', async () => {
    const r = await loadRoots(undefined, 'unset');

    expect(r.FS_PREFIX).toBe('');
    expect(r.IS_ROOTED).toBe(false);
    expect(r.WORKSPACE_DIR).toBe('/workspace');
    expect(r.AGENT_DIR).toBe('/workspace/agent');
    expect(r.EXTRA_DIR).toBe('/workspace/extra');
    expect(r.OUTBOX_DIR).toBe('/workspace/outbox');
    expect(r.APP_DIR).toBe('/app');
    expect(r.rooted('/workspace/inbound.db')).toBe('/workspace/inbound.db');
    expect(r.rooted('/app/.nanoclaw-session.json')).toBe('/app/.nanoclaw-session.json');
  });

  it('treats an empty prefix as unset', async () => {
    const r = await loadRoots('', 'empty');

    expect(r.IS_ROOTED).toBe(false);
    expect(r.AGENT_DIR).toBe('/workspace/agent');
  });

  it('resolves container paths under a prefix', async () => {
    const r = await loadRoots('/tmp/session-root', 'set');

    expect(r.IS_ROOTED).toBe(true);
    expect(r.WORKSPACE_DIR).toBe('/tmp/session-root/workspace');
    expect(r.AGENT_DIR).toBe('/tmp/session-root/workspace/agent');
    expect(r.EXTRA_DIR).toBe('/tmp/session-root/workspace/extra');
    expect(r.OUTBOX_DIR).toBe('/tmp/session-root/workspace/outbox');
    expect(r.APP_DIR).toBe('/tmp/session-root/app');
  });

  // A prefix arrives from a driver that built it with path.join, and a stray
  // trailing separator there would otherwise reach every consumer as a doubled
  // slash — which compares unequal to the same path without it, so a cache key
  // or a mount lookup keyed on the string would miss.
  it('strips trailing separators from the prefix', async () => {
    const r = await loadRoots('/tmp/session-root///', 'trailing');

    expect(r.FS_PREFIX).toBe('/tmp/session-root');
    expect(r.AGENT_DIR).toBe('/tmp/session-root/workspace/agent');
  });
});
