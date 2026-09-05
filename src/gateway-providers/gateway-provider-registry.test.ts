import { describe, expect, it } from 'vitest';

import type { GatewayApprovalSource, GatewayContribution, GatewayProvider } from './gateway-provider-registry.js';
import { getGatewayProviderFactory, injectsCredentials, registerGatewayProvider } from './gateway-provider-registry.js';

const CONTRIBUTION: GatewayContribution = { env: {} };

/**
 * An overlay written before `injectsCredentials` existed, as a stateful class
 * rather than an object literal.
 *
 * Nothing in this tree is shaped like this, and that is the point: overlays are
 * copied in by a skill and are never type-checked against this tree, so the
 * registry has to survive a shape it has never seen. The private field is what
 * makes the shape hostile — it resolves on the instance itself, so any wrapper
 * that rebinds `this` throws the first time `contribute` is called.
 */
class LegacyOverlayGateway {
  readonly kind = 'test-legacy-overlay';
  readonly #contribution: GatewayContribution;

  constructor(contribution: GatewayContribution) {
    this.#contribution = contribution;
  }

  async contribute(): Promise<GatewayContribution> {
    return this.#contribution;
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

    expect(injectsCredentials(provider)).toBe(true);
  });

  it('reads a declared false as false, and a declared true as true', () => {
    const off = { kind: 'test-declared-off', injectsCredentials: false } as unknown as GatewayProvider;
    const on = { kind: 'test-declared-on', injectsCredentials: true } as unknown as GatewayProvider;

    expect(injectsCredentials(off)).toBe(false);
    expect(injectsCredentials(on)).toBe(true);
  });

  // The default is read, never wrapped, so the registry hands back the object
  // the overlay's author wrote. A spread would drop a class instance's methods;
  // `Object.create` keeps them and rebinds `this`, so a private field throws;
  // a Proxy changes what `Object.keys` reports. None of that can happen to an
  // object nobody copied.
  it('hands a class-instance overlay back untouched, state and keys included', async () => {
    const instance = new LegacyOverlayGateway(CONTRIBUTION);
    const provider = provide('test-legacy-overlay', () => instance as unknown as GatewayProvider);

    expect(provider).toBe(instance as unknown as GatewayProvider);
    expect(injectsCredentials(provider)).toBe(true);
    await expect(provider.contribute({} as never)).resolves.toBe(CONTRIBUTION);
    expect(typeof provider.approvals).toBe('function');
    expect(Object.keys(provider)).toEqual(['kind']);
  });
});
