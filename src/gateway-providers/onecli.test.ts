import { describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../config.js', () => ({ ONECLI_URL: 'http://localhost:1', ONECLI_API_KEY: 'unused' }));

import { getGatewayProviderFactory } from './gateway-provider-registry.js';
import { contributionFromArgs } from './onecli.js';

describe('the onecli gateway provider', () => {
  // A model provider that ships a placeholder token reads this flag, so the
  // proxy that rewrites the Authorization header has to declare it.
  it('declares that it injects credentials', () => {
    expect(getGatewayProviderFactory('onecli')!().injectsCredentials).toBe(true);
  });
});

describe('contributionFromArgs', () => {
  it('types the closed grammar the SDK emits: -e pairs and ro mounts', () => {
    const contribution = contributionFromArgs(
      [
        '-e',
        'HTTPS_PROXY=http://host.docker.internal:15001',
        '-e',
        'SSL_CERT_FILE=/tmp/onecli-combined-ca.pem',
        '-v',
        '/tmp/onecli/ca.pem:/usr/local/share/ca.pem:ro',
        '-v',
        '/tmp/onecli/stub.json:/workspace/.config/creds.json:ro',
      ],
      'g1',
    );

    expect(contribution.env).toEqual({
      HTTPS_PROXY: 'http://host.docker.internal:15001',
      SSL_CERT_FILE: '/tmp/onecli-combined-ca.pem',
    });
    expect(contribution.mounts).toEqual([
      {
        class: 'allowlisted-extra',
        hostPath: '/tmp/onecli/ca.pem',
        containerPath: '/usr/local/share/ca.pem',
        mode: 'ro',
        groupScope: 'g1',
      },
      {
        class: 'allowlisted-extra',
        hostPath: '/tmp/onecli/stub.json',
        containerPath: '/workspace/.config/creds.json',
        mode: 'ro',
        groupScope: 'g1',
      },
    ]);
  });

  it('refuses argv outside the grammar — nothing rides raw around the spec again', () => {
    // Grammar drift in the SDK must break the spawn loudly, not smuggle flags.
    expect(() => contributionFromArgs(['--network', 'something'], 'g1')).toThrow(/cannot type/);
    expect(() => contributionFromArgs(['-v', '/odd'], 'g1')).toThrow(/cannot type/);
    expect(() => contributionFromArgs(['-v', 'h:c:rw:extra'], 'g1')).toThrow(/cannot type/);
  });
});
