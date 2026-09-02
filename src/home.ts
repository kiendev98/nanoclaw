/**
 * The host home: one root for every directory an AGENT can stand in.
 *
 * The group folder and the worktrees root each carried an environment variable
 * of their own, for one reason: Claude Code builds project memory by walking UP
 * from the agent's cwd and MERGING every CLAUDE.md it passes, and that walk does
 * not stop at a repository root. Upstream derives the group folder from
 * `process.cwd()`, which under launchd is this checkout, so the agent loaded
 * 21,100 tokens of the outer repository's maintainer guidance on every turn.
 *
 * So the property that matters is not the path, it is that NO ANCESTOR of this
 * root holds a CLAUDE.md. Point `NANOCLAW_HOME` anywhere that keeps that true.
 * Pointing it inside a repository re-creates the leak.
 *
 * One root rather than one variable per directory, because these trees differ
 * only in name: all host-owned, all outside every repository. A new one should
 * cost a `path.join`, not a new key.
 *
 * NOT the same thing as the runner roots in
 * `container/agent-runner/src/roots.ts`. Those are assigned per spawn from the
 * mount list, mapping a container path to an unrelated host path — arguments
 * crossing a process boundary rather than configuration. They cannot share a
 * prefix, and that module's comment explains why.
 *
 * `process.env` is read before `.env` because launchd does not export the file;
 * `envValue` parses `.env` itself regardless of the launcher, so the file still
 * beats the default under launchd. `env.js` depends only on fs, path and log,
 * which is what lets `worktree.ts` import this module — importing `config.ts`
 * would close a cycle, since config imports `parseProjectRoots` from worktree.
 */
import os from 'os';
import path from 'path';

import { envValue } from './env.js';

const HOME_DIR = process.env.HOME || os.homedir();

/** Read a key from the process environment, then `.env`, treating blank as unset. */
function setting(key: string): string {
  return (process.env[key] ?? envValue(key) ?? '').trim();
}

/**
 * Root for host-owned agent state.
 *
 * Defaults to `~/.config/nanoclaw`, which is where nanoclaw already keeps the
 * mount and sender allowlists, and which no repository sits above.
 */
export const NANOCLAW_HOME = path.resolve(setting('NANOCLAW_HOME') || path.join(HOME_DIR, '.config', 'nanoclaw'));

/** Per-group agent state: memory, the composed project document, telemetry. Persists across sessions. */
export const GROUPS_DIR = path.join(NANOCLAW_HOME, 'groups');

/** Per-worker git worktrees. Removed by a human, never automatically. */
export const WORKTREES_DIR = path.join(NANOCLAW_HOME, 'worktrees');
