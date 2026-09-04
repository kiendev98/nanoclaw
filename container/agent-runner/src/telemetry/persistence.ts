/**
 * Reading and writing the two telemetry stores. No state, no decisions.
 *
 * Two stores, because the two facts have different lifetimes. Context
 * occupancy is session-scoped and lives in session state. Rate-limit windows
 * are account-wide and live in the group folder. See `docs/message-footer.md`.
 *
 * Every failure is swallowed to null effect. The footer is cosmetic, and a
 * delivery must never fail over it.
 */
import fs from 'fs';
import path from 'path';

import { randomUUID } from 'crypto';

import { getFooterTelemetry, setFooterTelemetry } from '../db/session-state.js';
import { agentDir } from '../roots.js';

const GROUP_FILE = '.footer-telemetry.json';

/**
 * Resolved per call, not captured at import.
 *
 * A captured value would be the container default under test, pointing at a
 * path no test can write. Reading the variable here keeps the group store
 * exercisable, and picks up a driver that sets the root after first import.
 */
function groupFilePath(): string {
  return path.join(agentDir(), GROUP_FILE);
}

/** This session's context occupancy, or null when nothing is stored. */
export function readSessionTokens(): number | null {
  try {
    const raw = getFooterTelemetry();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { contextTokens?: number };
    return typeof parsed.contextTokens === 'number' ? parsed.contextTokens : null;
  } catch {
    // No mailbox yet, or a blob written by an older shape.
    return null;
  }
}

export function writeSessionTokens(contextTokens: number | null): void {
  try {
    setFooterTelemetry(JSON.stringify({ contextTokens: contextTokens ?? undefined }));
  } catch {
    // Storage unavailable. The value still applies for this process.
  }
}

/** Every stored window utilization, keyed by rate-limit type. */
export function readGroupWindows(): Record<string, number> {
  try {
    const parsed = JSON.parse(fs.readFileSync(groupFilePath(), 'utf-8')) as { windows?: Record<string, number> };
    const windows: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed.windows ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value)) windows[key] = value;
    }
    return windows;
  } catch {
    // No group file yet, or unreadable.
    return {};
  }
}

/**
 * Write the group-shared facts through a temp file and a rename.
 *
 * Sessions of one group run concurrently. `wx` refuses an existing path, so a
 * planted symlink is never followed. See `docs/message-footer.md`.
 */
export function writeGroupWindows(windows: Record<string, number>): void {
  const target = groupFilePath();
  const tmp = `${target}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ windows }), { flag: 'wx' });
    fs.renameSync(tmp, target);
  } catch {
    // Unwritable group folder. The values still apply for this process.
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The rename consumed it, or it was never created.
    }
  }
}
