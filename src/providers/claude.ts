/**
 * Claude provider container config.
 *
 * Loaded by the barrel on every install, not only the custom-endpoint one it
 * was written for. It now also carries the host's `claude` path, which a
 * host-driver session needs and a standard install has. With no custom
 * endpoint and no binary on PATH it contributes nothing, so always loading it
 * costs one `readEnvFile` and one PATH scan per spawn.
 *
 * The real auth token never enters the container. Setup creates an
 * OneCLI generic secret (host-pattern = base URL hostname, header-name
 * = Authorization, value-format = "Bearer {value}") so the proxy
 * rewrites the Authorization header on the wire. The container only
 * needs:
 *   - ANTHROPIC_BASE_URL — so the SDK knows where to call
 *   - ANTHROPIC_AUTH_TOKEN=placeholder — so the SDK adds an
 *     Authorization: Bearer header for OneCLI to overwrite
 */
import { resolveClaudeExecutable } from './claude-executable.js';
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('claude', (ctx) => {
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL']);
  const env: Record<string, string> = {};
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }

  // Where THIS host keeps `claude`, for a runner executing outside a
  // container. Resolved per spawn rather than once at load: PATH is a property
  // of the host at this moment, and an install that gains the binary must not
  // need a restart to find it. A containerised runner ignores the value; the
  // image has its own at a path this one would not name.
  const executable = resolveClaudeExecutable(ctx.hostEnv.PATH);
  if (executable) env.NANOCLAW_PROVIDER_EXECUTABLE = executable;
  // Absence is NOT warned here. A provider config is loaded for every spawn on
  // every driver, and under Docker the image carries its own binary — so a
  // warning from this point fired once per message on installs where the value
  // was never going to be read. The local driver reports it instead, once, in
  // `#reportMissingProviderExecutable`, where the value's absence matters.

  return { env };
});
