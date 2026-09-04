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

  it('warns when the driver isolates the network and no credential arrives', async () => {
    await directProvider().contribute({
      key: KEY,
      groupName: 'g1',
      capabilities: capabilities({ isolationTiers: ['container'], sharedNetworkNamespace: false }),
    });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no way to authenticate'), {
      group: 'g1',
      kind: 'direct',
    });
  });

  it('stays quiet when the driver shares the host network', async () => {
    vi.mocked(log.warn).mockClear();

    await directProvider().contribute({
      key: KEY,
      groupName: 'g1',
      capabilities: capabilities({ isolationTiers: ['container'], sharedNetworkNamespace: true }),
    });

    expect(log.warn).not.toHaveBeenCalled();
  });
});
