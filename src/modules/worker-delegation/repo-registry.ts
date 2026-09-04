/**
 * Which repositories a helper may be delegated into.
 *
 * One operator-owned environment variable names parent folders; every git
 * checkout directly inside one is a repository the assistant may name. The
 * catalog is therefore not a file a container can reach and edit, which is the
 * same reason `mount-security` keeps its allowlist outside the project root.
 *
 * Refusals name repositories, never paths. An install whose repository NAMES
 * are sensitive must keep those repositories out of the configured folders.
 */
import fs from 'fs';
import path from 'path';

import { envValue } from '../../env.js';
import { log } from '../../log.js';

const ROOTS_ENV_VAR = 'NANOCLAW_PROJECT_ROOTS';

export interface ResolvedRepo {
  name: string;
  /** The real path of the operator's own clone. Never shown to an agent. */
  hostPath: string;
}

/**
 * Why a repository could not be resolved.
 *
 * `retryable` is the caller's whole decision: a name the caller chose can be
 * chosen again, while an unconfigured install is an operator problem no retry
 * reaches (E1/E2).
 */
export type RepoRefusal =
  | { kind: 'not-configured'; retryable: false }
  | { kind: 'no-repositories'; retryable: false }
  | { kind: 'malformed-name'; retryable: false }
  | { kind: 'unknown-name'; retryable: true; available: string[] };

/** `process.env` first, because launchd does not export `.env`. */
function configuredRoots(): string[] {
  const raw = (process.env[ROOTS_ENV_VAR] ?? envValue(ROOTS_ENV_VAR) ?? '').trim();
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isGitCheckout(candidate: string): boolean {
  return fs.existsSync(path.join(candidate, '.git'));
}

/** Resolve through symlinks, or undefined when the path does not exist. */
function realPathOrUndefined(candidate: string): string | undefined {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return undefined;
  }
}

/** Every repository name the assistant may use, sorted, deduplicated. */
export function listRepoNames(): string[] {
  const names = new Set<string>();
  for (const root of configuredRoots()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      // A configured folder that cannot be read makes every repository inside
      // it vanish from the list, which reads to a caller as "not registered".
      log.warn('Configured repository folder is unreadable', { root, err });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (isGitCheckout(path.join(root, entry.name))) names.add(entry.name);
    }
  }
  return [...names].sort();
}

/**
 * A name is one path segment, and it stays one after resolution.
 *
 * Separators and `..` are refused rather than normalised: normalising accepts
 * the caller's intent to leave the folder and then silently rewrites it.
 */
function isSingleSegment(name: string): boolean {
  return Boolean(name) && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..';
}

/**
 * Find the operator's clone for a repository name.
 *
 * The containment check runs on real paths, so a symlink inside a configured
 * folder cannot point the helper at a checkout the operator never offered.
 */
export function resolveRepo(name: string): ResolvedRepo | RepoRefusal {
  const roots = configuredRoots();
  if (roots.length === 0) return { kind: 'not-configured', retryable: false };
  if (!isSingleSegment(name)) return { kind: 'malformed-name', retryable: false };

  for (const root of roots) {
    const realRoot = realPathOrUndefined(root);
    if (!realRoot) continue;
    const realCandidate = realPathOrUndefined(path.join(realRoot, name));
    if (!realCandidate) continue;
    if (realCandidate !== path.join(realRoot, name) && !realCandidate.startsWith(realRoot + path.sep)) continue;
    if (!isGitCheckout(realCandidate)) continue;
    return { name, hostPath: realCandidate };
  }

  const available = listRepoNames();
  if (available.length === 0) return { kind: 'no-repositories', retryable: false };
  return { kind: 'unknown-name', retryable: true, available };
}

export function isRepoRefusal(result: ResolvedRepo | RepoRefusal): result is RepoRefusal {
  return 'kind' in result;
}

/** The text an agent sees. Names only — never a host path (E3). */
export function describeRefusal(refusal: RepoRefusal): string {
  switch (refusal.kind) {
    case 'not-configured':
      return `No repositories are configured for delegation. Ask the operator to set ${ROOTS_ENV_VAR}. Retrying will not help.`;
    case 'no-repositories':
      return 'No repositories are available for delegation. This is an operator problem, and retrying will not help.';
    case 'malformed-name':
      return 'A repository is named by one folder name, with no path separators. Retrying will not help.';
    case 'unknown-name':
      return `Unknown repository. Available repositories: ${refusal.available.join(', ')}.`;
  }
}
