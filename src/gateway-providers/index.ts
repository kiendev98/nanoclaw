/**
 * Gateway provider selection.
 *
 * `NANOCLAW_GATEWAY_PROVIDER` is read once, at first use, and defaults to
 * `onecli` — an install that never sets it behaves exactly as it always has.
 * One active provider per install; a configured kind with no registered
 * provider throws the same operator-error shape as an unknown runtime driver,
 * for the same reason: a host configured for one gateway must not silently
 * spawn through another.
 *
 * Settings honor `.env` with `process.env` taking precedence, like every
 * other NanoClaw setting (see `drivers/index.ts` for why).
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import {
  getGatewayProviderFactory,
  listGatewayProviderKinds,
  type GatewayProvider,
  type GatewayProviderKind,
} from './gateway-provider-registry.js';
// Side-effect import: the barrel overlays append their registration to.
import './installed.js';

/**
 * This fork defaults to `direct` where upstream defaults to `onecli`, because
 * it runs the agent on the host under the `local` driver: the agent
 * authenticates as the user through the local `claude`, so there is no
 * credential for a broker to inject. Keeping `onecli` as the default made
 * every spawn depend on a network call that can only fail here — and it is
 * fail-closed, so a 401 aborted the spawn before the driver ran at all.
 *
 * `onecli` is still registered. Set NANOCLAW_GATEWAY_PROVIDER=onecli to use it,
 * which is what an isolating driver needs.
 */
const DEFAULT_GATEWAY_PROVIDER_KIND = 'direct';

export function configuredGatewayProviderKind(env: NodeJS.ProcessEnv = process.env): GatewayProviderKind {
  const configured =
    env.NANOCLAW_GATEWAY_PROVIDER?.trim() ||
    readEnvFile(['NANOCLAW_GATEWAY_PROVIDER']).NANOCLAW_GATEWAY_PROVIDER?.trim() ||
    '';
  return configured.toLowerCase() || DEFAULT_GATEWAY_PROVIDER_KIND;
}

let installed: GatewayProvider | null = null;

export function getGatewayProvider(): GatewayProvider {
  if (!installed) {
    const kind = configuredGatewayProviderKind();
    const factory = getGatewayProviderFactory(kind);
    if (!factory) {
      throw new Error(
        `NANOCLAW_GATEWAY_PROVIDER='${kind}' but no gateway provider is registered for '${kind}'; ` +
          `installed: ${listGatewayProviderKinds().join(', ')}. ` +
          'Other gateways arrive as overlays — install the gateway skill or unset the variable.',
      );
    }
    installed = factory();
    log.info('Gateway provider selected', { gatewayProvider: installed.kind });
  }
  return installed;
}

/** Test seam: drop the memoized provider so a suite can inject another one. */
export function resetGatewayProvider(next: GatewayProvider | null = null): void {
  installed = next;
}

export * from './gateway-provider-registry.js';
