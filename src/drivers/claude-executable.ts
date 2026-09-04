/**
 * Find the `claude` binary on this host's PATH.
 *
 * The agent runner defaults to `/pnpm/claude`, where the agent image installs
 * it. Nothing is there on a host, so the host has to say where the real one is.
 * That process is also what reads the OS keychain, which is what lets a host run
 * authenticate as the user with no token -- so failing to find it is not a
 * missing convenience, it is the whole credential story gone.
 *
 * Returns undefined rather than throwing: the runner then falls back to its
 * container default and fails with the SDK's own message, which names the path
 * it looked for. That is a better error than one invented here.
 *
 * Its own module because two callers need it and they may not import each
 * other: the local driver warns when it is missing, and `container-config.ts`
 * writes it into `container.json` for the runner.
 */
import fs from 'fs';
import path from 'path';

export function resolveClaudeExecutable(pathEnv: string | undefined): string | undefined {
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here, keep looking
    }
  }
  return undefined;
}
