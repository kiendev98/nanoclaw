import path from 'path';
import { fileURLToPath } from 'url';

import { AGENT_DIR } from '../roots.js';
import { renderMemorySection } from './context.js';

const MEMORY_CONTEXT_SOURCES = ['startup', 'clear', 'compact'] as const;

export type MemorySessionHookSource = (typeof MEMORY_CONTEXT_SOURCES)[number];
export type MemorySessionStartSource = MemorySessionHookSource | 'resume';

export interface MemorySessionHookRegistration {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly MemorySessionHookSource[];
}

/** Quote one argument for the shell that runs this command. */
function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The hook runs as its own process, so the command has to name a real file.
 *
 * Both operands are derived, and both used to be literals only a container
 * could satisfy. `/app/src` is a bind mount, so a host run resolves the same
 * module under the checkout instead. `AGENT_DIR` was not passed at all, which
 * left the hook on its own default — the container's `/workspace/agent`.
 *
 * Getting either wrong fails silently. A SessionStart hook that exits non-zero
 * is non-blocking, so a host session started with no memory at all while the
 * composed project document went on telling the agent its memory files were
 * loaded. Deriving both covers the container and the host in one expression,
 * with no environment variable and no branch on which one is running.
 */
const HOOK_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hook.ts');

export const MEMORY_SESSION_HOOK: MemorySessionHookRegistration = {
  command: `bun ${shellArg(HOOK_ENTRY)} ${shellArg(AGENT_DIR)}`,
  // Every command an earlier version wrote into a settings file, so a run that
  // no longer writes one can still take its predecessors' entries out. The
  // second is the `/app` literal this module used to publish: under the local
  // driver it landed in the operator's own ~/.claude, where it failed on every
  // session they started, agent or not.
  legacyCommands: ['bun /app/src/memory-hook.ts', 'bun /app/src/memory/hook.ts'],
  sources: MEMORY_CONTEXT_SOURCES,
};

/** Return memory only when a provider is establishing a new context window. */
export function memoryContextForSessionStart(source: MemorySessionStartSource, baseDir?: string): string | undefined {
  return source === 'resume' ? undefined : renderMemorySection(baseDir);
}
