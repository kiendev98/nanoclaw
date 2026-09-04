/**
 * Filesystem roots for the agent runner.
 *
 * The runner was written for exactly one filesystem: the container's, where
 * `/workspace`, `/app`, and `/home/node/.claude` are bind mount targets the
 * driver guarantees. Running the same code as a host process breaks that
 * assumption — a Mac has no `/workspace`, and creating one would be a system
 * change to serve a single program.
 *
 * So each root is named here and each reads its own environment variable,
 * defaulting to the container path it has always had. A host driver sets the
 * variables to real directories; a container sets none.
 *
 * **Unset is the container case, and it must stay byte-identical.** With no
 * variables set, every export below evaluates to the exact string the runner
 * computed before this module existed. Any change here that alters an
 * unset-environment result is a regression in the default path, not a
 * refactor, and `roots.test.ts` asserts it root by root.
 *
 * ## Why one variable per root, and not a single prefix
 *
 * A single `NANOCLAW_FS_PREFIX` looks tidier and is wrong, because the mounts
 * overlap. `/workspace` is the session directory and `/workspace/agent` is the
 * group directory, which is a different host directory nested inside the first
 * one's path. Under a prefix, a host driver has to realize that shape as a
 * symlink tree — and the moment `/workspace` becomes a symlink, a link planted
 * at `/workspace/agent` is written *into the session directory*, not beside it.
 *
 * Mirroring instead of linking is worse. The runner does not only read
 * `/workspace/agent`: `ensureMemoryScaffold` and the conversations directory
 * write there, and the group directory is host-backed precisely so that memory
 * survives a session. A mirror of symlinks resolves existing entries and
 * silently swallows new ones into a per-session directory that is discarded,
 * so the agent would lose its memory between sessions with nothing logged.
 *
 * Naming each root sidesteps all of it: overlapping paths become independent
 * variables, writes land in the real directory, and the driver plants no
 * symlinks except for `extra/`, whose entries genuinely are leaves.
 *
 * Values are read once at module load. A driver sets them in the child's
 * environment before spawn; a setter would only invite a half-migrated process
 * holding two roots at once.
 */
import path from 'path';

/** Read an override, treating whitespace-only as unset. */
function root(envVar: string, containerDefault: string): string {
  const value = (process.env[envVar] ?? '').trim();
  return value ? value.replace(/\/+$/, '') : containerDefault;
}

/**
 * The same resolution, read at call time instead of at import.
 *
 * The constants below are the normal way in: a driver sets the environment
 * before spawn, so import time is correct for the runner's own modules. A
 * caller that must tolerate the root changing after first import — a test
 * suite, or a module loaded before the driver's variables land — asks for it
 * here instead of re-implementing the trim. There is deliberately no setter;
 * see the module comment.
 */
export function currentRoot(envVar: string, containerDefault: string): string {
  return root(envVar, containerDefault);
}

/** The session workspace: mailbox databases, outbox, heartbeat. */
export const WORKSPACE_DIR = root('NANOCLAW_SESSION_DIR', '/workspace');

/**
 * The agent group folder, and the process working directory.
 *
 * Nested inside `WORKSPACE_DIR`'s path in a container and a wholly separate
 * host directory outside one, which is the overlap the module comment explains.
 */
export const AGENT_DIR = root('NANOCLAW_AGENT_DIR', '/workspace/agent');

/** `AGENT_DIR`, resolved now. See `currentRoot`. */
export function agentDir(): string {
  return root('NANOCLAW_AGENT_DIR', '/workspace/agent');
}

/** Parent of the allowlisted extra mounts. Its entries are leaves. */
export const EXTRA_DIR = root('NANOCLAW_EXTRA_DIR', '/workspace/extra');

/**
 * Where `send_file` stages what it hands back to the channel.
 *
 * Derived, not named: the outbox is always a leaf of the session workspace, and
 * relocating it alone would split a tree the runner treats as one. It carried a
 * variable of its own until nothing was found to set it.
 */
export const OUTBOX_DIR = path.join(WORKSPACE_DIR, 'outbox');

/**
 * The shared skills, staged as a plugin the provider loads per session.
 *
 * Derived for the same reason as the outbox: it is always a leaf of the session
 * workspace, staged there by the host at spawn. Naming it would be a seventh
 * environment variable for a path that has exactly one possible value.
 *
 * Skills also reach a container through `.claude-shared/skills/<name>` ->
 * `/app/skills/<name>`. That route needs two things a host driver does not
 * have: a container filesystem to resolve `/app`, and a settings directory the
 * agent searches — `HOME` is inherited, so `user` scope is the operator's own
 * `~/.claude`. Both failed, so every shared skill was silently absent while the
 * composed project document went on naming them.
 *
 * A plugin is a runtime argument rather than a location, so it depends on
 * neither. The host stages it here at spawn; see `src/skill-delivery.ts`.
 */
export const SKILLS_PLUGIN_DIR = path.join(WORKSPACE_DIR, 'plugin');

/** Per-session routing context, written by the host before spawn. */
export const SESSION_CONTEXT_PATH = root('NANOCLAW_SESSION_CONTEXT_PATH', '/app/.nanoclaw-session.json');

/** True when this process is running outside a container. */
export const IS_HOSTED: boolean = Boolean((process.env.NANOCLAW_AGENT_DIR ?? '').trim());
