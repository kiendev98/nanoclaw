import { describe, expect, it } from 'vitest';

import type { GatewayApprovalSource, GatewayContribution, GatewayProvider } from './gateway-provider-registry.js';
import { getGatewayProviderFactory, registerGatewayProvider } from './gateway-provider-registry.js';

const CONTRIBUTION: GatewayContribution = { env: {} };

/**
 * An overlay written before `injectsCredentials` existed, as a class rather
 * than an object literal.
 *
 * Nothing in this tree is shaped like this, and that is the point: overlays are
 * copied in by a skill and are never type-checked against this tree, so the
 * registry has to survive a shape it has never seen.
 */
class LegacyOverlayGateway {
  readonly kind = 'test-legacy-overlay';

  async contribute(): Promise<GatewayContribution> {
    return CONTRIBUTION;
  }

  approvals(): GatewayApprovalSource {
    return { subscribe: () => ({ stop: () => {} }) };
  }
}

function provide(kind: string, factory: () => GatewayProvider): GatewayProvider {
  registerGatewayProvider(kind, factory);
  const registered = getGatewayProviderFactory(kind);
  if (!registered) throw new Error(`the ${kind} gateway is not registered`);
  return registered();
}

describe('an undeclared injectsCredentials', () => {
  it('reads as true, because every gateway predating the field is a proxy', () => {
    const provider = provide(
      'test-plain-overlay',
      () => ({ kind: 'test-plain-overlay' }) as unknown as GatewayProvider,
    );

    expect(provider.injectsCredentials).toBe(true);
  });

  // A spread copies own enumerable properties only. A class instance reaching
  // the caller without `contribute` throws on its first spawn, and one without
  // `approvals` leaves every credentialed action hanging until the gateway
  // times out — neither failure names the registry that caused it.
  it('keeps the methods of a class-instance overlay', async () => {
    const provider = provide('test-legacy-overlay', () => new LegacyOverlayGateway() as unknown as GatewayProvider);

    expect(provider.injectsCredentials).toBe(true);
    expect(typeof provider.contribute).toBe('function');
    expect(typeof provider.approvals).toBe('function');
    await expect(provider.contribute({} as never)).resolves.toBe(CONTRIBUTION);
  });

  it('leaves a provider that declares the field untouched', () => {
    const declared = { kind: 'test-declared', injectsCredentials: false } as unknown as GatewayProvider;

    expect(provide('test-declared', () => declared)).toBe(declared);
  });
});
