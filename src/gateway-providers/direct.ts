/**
 * The `direct` gateway — the one that contributes nothing, on purpose.
 *
 * A gateway exists to get credentials *into a container*: the agent has no
 * secrets of its own, so a broker mints or proxies them per session and hands
 * the spec the env and mounts that carry them. That is the right design when
 * the agent is isolated.
 *
 * Under the `local` driver there is no container and no isolation, and the
 * agent authenticates as the user: the SDK spawns the local `claude`, which
 * reads its own credentials from the OS keychain. There is nothing left for a
 * broker to broker, so brokering anyway means a network round trip that can
 * only fail — which is exactly what it did. `onecli` is fail-closed by
 * contract, so a 401 from its agent registration aborted every spawn before
 * the driver was ever reached, and the message sat pending through retry after
 * retry with the real cause three frames down a stack trace.
 *
 * Named `direct` rather than `none` because it is a statement about how
 * credentials are obtained — straight from the host — not the absence of a
 * decision. Selecting it is a claim that the runtime already has the identity
 * it needs. **Do not pair it with a driver that isolates**, because there it
 * would be exactly that absence: a container with no way to authenticate.
 */
import { log } from '../log.js';

import { registerGatewayProvider, type GatewayProviderInput } from './gateway-provider-registry.js';

registerGatewayProvider('direct', () => ({
  kind: 'direct',

  contribute: async (input: GatewayProviderInput) => {
    // Loud once per spawn rather than silent: an operator who selected this by
    // accident on an isolating driver gets a session whose agent cannot
    // authenticate, and this line is the only thing that names why.
    if (input.capabilities.isolationTiers.length > 0 && !input.capabilities.sharedNetworkNamespace) {
      log.warn(
        'direct gateway contributes no credentials, but the driver isolates the network — the agent may have no way to authenticate',
        { group: input.groupName, kind: 'direct' },
      );
    }
    return {};
  },

  // No `approvals()`: there are no held requests to approve, because nothing is
  // proxied. The approvals module treats the seam as absent, which is accurate
  // rather than an empty implementation pretending to be a flow.
}));
