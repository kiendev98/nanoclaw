/**
 * Find the `claude` binary on this host's PATH.
 *
 * The agent runner defaults to `/pnpm/claude`, where the agent image installs
 * it. Nothing is there on a host, so the host must say where the real one is.
 * That process also reads the OS keychain. The keychain is what lets a host run
 * authenticate as the user with no token. Failing to find it is therefore not a
 * missing convenience. It is the whole credential story gone.
 *
 * Returns undefined rather than throwing. The runner falls back to its container
 * default, and fails with the SDK's own message naming the path it looked for.
 * That is a better error than one invented here.
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
