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
 * it needs. It refuses a driver that isolates the session, because there the
 * claim is false: a container with no way to authenticate.
 */
import { registerGatewayProvider, type GatewayProviderInput } from './gateway-provider-registry.js';

registerGatewayProvider('direct', () => ({
  kind: 'direct',
  injectsCredentials: false,

  contribute: async (input: GatewayProviderInput) => {
    // `isolationTiers` names the spec tiers a driver ACCEPTS, not what it
    // contains: the local driver reports 'container' and isolates nothing.
    // `sharedNetworkNamespace` is the only capability that separates a host
    // process from an isolated session, so it carries the whole check.
    // A driver that isolates while sharing one namespace must select `onecli`.
    if (!input.capabilities.sharedNetworkNamespace) {
      // Fail closed, per the `contribute` contract. A warning let the spawn
      // continue, and the container then failed auth on every agent turn with
      // no host-side error to read.
      throw new Error(
        `The direct gateway contributes no credentials, and the driver of agent group '${input.groupName}' ` +
          'does not share a network namespace. The agent would start with no way to authenticate. ' +
          'Set NANOCLAW_GATEWAY_PROVIDER=onecli for an isolating driver.',
      );
    }
    return {};
  },

  // No `approvals()`: there are no held requests to approve, because nothing is
  // proxied. The approvals module treats the seam as absent, which is accurate
  // rather than an empty implementation pretending to be a flow.
}));
