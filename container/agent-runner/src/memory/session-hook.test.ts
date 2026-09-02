import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AGENT_DIR } from '../roots.js';
import { MEMORY_SESSION_HOOK, memoryContextForSessionStart, type MemorySessionStartSource } from './session-hook.js';

/** Split the registered command back into `bun`, the entry, and the base dir. */
function parseCommand(command: string): { runtime: string; args: string[] } {
  const parts = command.match(/'(?:[^']|'\\'')*'|\S+/g) ?? [];
  const [runtime, ...args] = parts.map((part) =>
    part.startsWith("'") ? part.slice(1, -1).replace(/'\\''/g, "'") : part,
  );
  return { runtime: runtime ?? '', args };
}

describe('memory SessionStart contract', () => {
  it('injects startup, clear, and compact but not resume', () => {
    expect(MEMORY_SESSION_HOOK.sources).toEqual(['startup', 'clear', 'compact']);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-hook-contract-'));
    try {
      fs.mkdirSync(path.join(base, 'memory', 'system'), { recursive: true });
      fs.writeFileSync(path.join(base, 'memory', 'index.md'), '# Memory Index\n');
      fs.writeFileSync(path.join(base, 'memory', 'system', 'definition.md'), '# Definition\n');
      const expected: Record<MemorySessionStartSource, boolean> = {
        startup: true,
        resume: false,
        clear: true,
        compact: true,
      };
      for (const [source, shouldInject] of Object.entries(expected)) {
        expect(Boolean(memoryContextForSessionStart(source as MemorySessionStartSource, base))).toBe(shouldInject);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  // The command used to name `/app/src/memory/hook.ts`, which exists only
  // inside a container. On a host every session start died with
  // `Module not found`, and a SessionStart hook that exits non-zero is
  // non-blocking — so the session ran on with no memory and no complaint.
  it('runs a hook file that exists wherever the runner is running', () => {
    const { runtime, args } = parseCommand(MEMORY_SESSION_HOOK.command);

    expect(runtime).toBe('bun');
    expect(fs.existsSync(args[0]!)).toBe(true);
    expect(path.basename(args[0]!)).toBe('hook.ts');
  });

  // Without this the hook falls back to its own default, which is the
  // container's `/workspace/agent` — a path that does not exist on a host, so
  // both memory files read as unavailable and the section ships empty.
  it('passes the agent directory instead of leaving the hook on its default', () => {
    const { args } = parseCommand(MEMORY_SESSION_HOOK.command);

    expect(args[1]).toBe(AGENT_DIR);
  });

  it('remembers every command an earlier version wrote to a settings file', () => {
    expect(MEMORY_SESSION_HOOK.legacyCommands).toEqual(['bun /app/src/memory-hook.ts', 'bun /app/src/memory/hook.ts']);
  });
});
