/**
 * Filesystem roots for the agent runner.
 *
 * The runner was written for exactly one filesystem: the container's, where
 * `/workspace`, `/app`, and `/home/node/.claude` are bind mount targets the
 * driver guarantees. Running the same code as a host process breaks that
 * assumption — a Mac has no `/workspace`, and creating one would be a system
 * change to serve a single program.
 *
 * So every absolute container path in this tree resolves through `rooted()`,
 * which prepends `NANOCLAW_FS_PREFIX`. The local driver points that at a
 * per-session directory holding symlinks with the same shape the container
 * mounts have. Nothing else changes: the runner still opens
 * `<root>/workspace/agent`, and the link underneath decides where that lands.
 *
 * **Unset is the container case, and it must stay byte-identical.** With no
 * prefix `rooted()` returns its argument unchanged, so a container spawn
 * computes exactly the strings it computed before this module existed. Any
 * change here that alters the empty-prefix result is a regression in the
 * default path, not a refactor.
 *
 * The prefix is read once at module load. A driver sets it in the child's
 * environment before spawn; nothing rewrites it mid-run, and a setter would
 * only invite a half-migrated process with two roots.
 */
import path from 'path';

/**
 * Absolute host directory the container paths hang off, or `''` in a
 * container. Trailing slashes are stripped so `rooted()` cannot produce a
 * doubled separator.
 */
export const FS_PREFIX: string = (process.env.NANOCLAW_FS_PREFIX ?? '').replace(/\/+$/, '');

/** True when this process is running outside a container, under a prefix. */
export const IS_ROOTED: boolean = FS_PREFIX !== '';

/**
 * Resolve a container-absolute path against the prefix.
 *
 * @param containerPath An absolute path as the container sees it, e.g. `/workspace/agent`.
 * @returns The same string when no prefix is set; otherwise the path under the prefix.
 */
export function rooted(containerPath: string): string {
  return FS_PREFIX ? path.join(FS_PREFIX, containerPath) : containerPath;
}

/** The session workspace: mailbox databases, outbox, heartbeat. */
export const WORKSPACE_DIR = rooted('/workspace');

/** The agent group folder, and the process working directory. */
export const AGENT_DIR = rooted('/workspace/agent');

/** Parent of the allowlisted extra mounts. */
export const EXTRA_DIR = rooted('/workspace/extra');

/** Where `send_file` stages what it hands back to the channel. */
export const OUTBOX_DIR = rooted('/workspace/outbox');

/** The runner's own install root — session context lands here. */
export const APP_DIR = rooted('/app');
