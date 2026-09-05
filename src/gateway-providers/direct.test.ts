import { describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../config.js', () => ({ ONECLI_URL: 'http://localhost:1', ONECLI_API_KEY: 'unused' }));
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }));

import type { DriverCapabilities, SessionKey } from '../drivers/types.js';
import { log } from '../log.js';

import './direct.js';
import { getGatewayProviderFactory } from './gateway-provider-registry.js';
import { configuredGatewayProviderKind } from './index.js';

const KEY: SessionKey = { installSlug: 'test', agentGroupId: 'ag-1', sessionId: 'sess-1' };

function capabilities(overrides: Partial<DriverCapabilities> = {}): DriverCapabilities {
  return {
    isolationTiers: [],
    admissionEnforced: false,
    networkPolicy: 'declarative',
    encryptedVolumes: false,
    unrealized: [],
    readonlyMounts: false,
    sharedNetworkNamespace: true,
    auxiliaryContainers: false,
    imageBuild: false,
    ...overrides,
  };
}

function directProvider() {
  const factory = getGatewayProviderFactory('direct');
  if (!factory) throw new Error('the direct gateway is not registered');
  return factory();
}

describe('the direct gateway default', () => {
  // This fork runs the local driver, where a broker has no credential to
  // inject. An upstream merge that restores the `onecli` default takes the
  // bot down: every spawn aborts on a 401 before the driver runs.
  it('selects direct when nothing is configured', () => {
    expect(configuredGatewayProviderKind({})).toBe('direct');
  });

  it('still honours an explicit onecli selection', () => {
    expect(configuredGatewayProviderKind({ NANOCLAW_GATEWAY_PROVIDER: 'onecli' })).toBe('onecli');
  });

  it('lowercases what an operator configured', () => {
    expect(configuredGatewayProviderKind({ NANOCLAW_GATEWAY_PROVIDER: 'OneCLI' })).toBe('onecli');
  });
});

describe('the direct gateway provider', () => {
  it('registers under direct', () => {
    expect(directProvider().kind).toBe('direct');
  });

  it('contributes no env and no mounts', async () => {
    const contribution = await directProvider().contribute({
      key: KEY,
      groupName: 'g1',
      capabilities: capabilities(),
    });

    expect(contribution).toEqual({});
  });

  it('exposes no approvals seam, because nothing is proxied', () => {
    expect(directProvider().approvals).toBeUndefined();
  });

  it('declares that it injects no credentials', () => {
    expect(directProvider().injectsCredentials).toBe(false);
  });

  // A warning here let the spawn continue. The container then started with no
  // proxy env, failed auth on every turn, and lost its logs on exit.
  it('refuses the spawn when the driver does not share a network namespace', async () => {
    await expect(
      directProvider().contribute({
        key: KEY,
        groupName: 'g1',
        capabilities: capabilities({ isolationTiers: ['container'], sharedNetworkNamespace: false }),
      }),
    ).rejects.toThrow(/NANOCLAW_GATEWAY_PROVIDER=onecli/);
  });

  // Red if the check reads `isolationTiers` again: that list names the spec
  // tiers a driver accepts, so a driver can isolate and report none.
  it('refuses a driver that reports no isolation tier and a private network', async () => {
    await expect(
      directProvider().contribute({
        key: KEY,
        groupName: 'g1',
        capabilities: capabilities({ isolationTiers: [], sharedNetworkNamespace: false }),
      }),
    ).rejects.toThrow(/no way to authenticate/);
  });

  it('names the agent group, because the container keeps no log of its own', async () => {
    await expect(
      directProvider().contribute({
        key: KEY,
        groupName: 'billing-bot',
        capabilities: capabilities({ sharedNetworkNamespace: false }),
      }),
    ).rejects.toThrow(/billing-bot/);
  });

  it('contributes and stays quiet when the driver shares the host network', async () => {
    vi.mocked(log.warn).mockClear();

    const contribution = await directProvider().contribute({
      key: KEY,
      groupName: 'g1',
      capabilities: capabilities({ isolationTiers: ['container'], sharedNetworkNamespace: true }),
    });

    expect(contribution).toEqual({});
    expect(log.warn).not.toHaveBeenCalled();
  });
});
