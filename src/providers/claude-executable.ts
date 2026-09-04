/**
 * Find the `claude` binary on this host's PATH.
 *
 * The runner defaults to `/pnpm/claude`, which no host has. That binary also
 * reads the OS keychain, so failing to find it costs the whole credential
 * story. Returns undefined rather than throwing, so the runner fails with the
 * SDK's own message. See `docs/local-driver.md`.
 *
 * Lives beside the provider that registers it, not in `drivers/`: a driver
 * never computes or looks anything up, and this is a host-state lookup.
 */
import fs from 'fs';
import path from 'path';

export function resolveClaudeExecutable(pathEnv: string | undefined): string | undefined {
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      // A DIRECTORY named `claude` carries the execute bit too, and handing
      // one to the SDK as `pathToClaudeCodeExecutable` fails inside the child
      // with a message that names neither this PATH entry nor this function.
      if (!fs.statSync(candidate).isFile()) continue;
      return candidate;
    } catch {
      // not here, keep looking
    }
  }
  return undefined;
}
