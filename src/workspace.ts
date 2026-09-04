/**
 * The one root an operator configures. Everything host-owned derives from it.
 *
 * Upstream derives `groups/`, `data/` and `store/` from `process.cwd()`, which
 * under launchd is this checkout. That puts agent state inside a repository,
 * and Claude Code builds project memory by walking UP from the agent's cwd,
 * merging every CLAUDE.md it passes. The walk does not stop at a repository
 * root, so an agent standing in `<checkout>/groups/<folder>` loads the
 * checkout's own maintainer guidance on every turn.
 *
 * So the property that matters is not the path, it is that NO ANCESTOR of this
 * root holds a CLAUDE.md. Point `NANOCLAW_WORKSPACE_DIR` anywhere that keeps
 * that true. Pointing it inside a repository re-creates the leak.
 *
 * One root rather than one variable per tree, because these trees differ only
 * in name: all host-owned, all outside every repository. A new one costs a
 * `path.join`, not a new key.
 *
 * NOT the same thing as the runner roots in
 * `container/agent-runner/src/roots.ts`. Those are assigned per spawn from the
 * mount list, mapping a container path to an unrelated host path. They are
 * arguments crossing a process boundary, not configuration, and that module
 * explains why they cannot share a prefix.
 *
 * This module imports only `env.js`, which depends on fs, path and log. It
 * cannot import `config.ts`: config imports from modules that import this one.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { envValue } from './env.js';

const HOME_DIR = process.env.HOME || os.homedir();

/** `process.env` first, because launchd does not export `.env`. */
function setting(key: string): string {
  return (process.env[key] ?? envValue(key) ?? '').trim();
}

/** Root for every host-owned tree. */
export const WORKSPACE_DIR = path.resolve(setting('NANOCLAW_WORKSPACE_DIR') || path.join(HOME_DIR, '.saber'));

/** Per-group agent state: memory, the composed project document, telemetry. */
export const GROUPS_DIR = path.join(WORKSPACE_DIR, 'groups');

/** The central DB, per-session mailboxes, and driver session records. */
export const DATA_DIR = path.join(WORKSPACE_DIR, 'data');

/** Channel adapter state. */
export const STORE_DIR = path.join(WORKSPACE_DIR, 'store');

/**
 * Stop rather than start on an empty workspace beside a populated checkout.
 *
 * State used to live in the checkout. Starting with the new root would create
 * an empty database and report healthy, and the operator would find every
 * agent group gone with nothing logged. The move is theirs to make, because
 * only they know which of two installs owns the data.
 */
export function assertWorkspaceMigrated(projectRoot: string = process.cwd()): void {
  const legacy = path.join(projectRoot, 'data', 'v2.db');
  if (fs.existsSync(path.join(DATA_DIR, 'v2.db')) || !fs.existsSync(legacy)) return;

  // Only the trees that are actually there. Naming an absent one sends the
  // operator to fix a `mv` that was never needed.
  const moves = (
    [
      ['data', DATA_DIR],
      ['groups', GROUPS_DIR],
      ['store', STORE_DIR],
    ] as const
  )
    .filter(([tree]) => fs.existsSync(path.join(projectRoot, tree)))
    // Contents, not the directory: a destination that already holds the other
    // trees would otherwise take `data` as `data/data`. Copy, so the original
    // survives as a fallback until the operator deletes it.
    .map(([tree, dest]) => `  cp -R ${path.join(projectRoot, tree)}/. ${dest}/`);

  throw new Error(
    `Agent state still lives in the checkout, and NANOCLAW_WORKSPACE_DIR is ${WORKSPACE_DIR}. ` +
      `Copy it across, then start again:\n` +
      `  mkdir -p ${[DATA_DIR, GROUPS_DIR, STORE_DIR].join(' ')}\n` +
      `${moves.join('\n')}\n` +
      `To keep the old layout instead, set NANOCLAW_WORKSPACE_DIR=${projectRoot} in .env.`,
  );
}
