/**
 * The Claude provider's host-side contribution.
 *
 * This is the seam that replaced a `hostClaudeExecutable` field threaded
 * through two shared types. A second provider now adds one file and one barrel
 * line instead of editing eight sites, so the contribution has to be right.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getProviderContainerConfig } from './provider-container-registry.js';
import './claude.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

function contextWith(pathEnv: string): Parameters<NonNullable<ReturnType<typeof getProviderContainerConfig>>>[0] {
  return {
    sessionDir: '/tmp/session',
    agentGroupId: 'ag-1',
    groupDir: '/tmp/group',
    selectedSkills: [],
    hostEnv: { PATH: pathEnv },
  };
}

let binDir: string;

beforeEach(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-claude-bin-'));
});

describe('claude provider container config', () => {
  it('registers itself, so the barrel import is what wires it', () => {
    expect(getProviderContainerConfig('claude')).toBeTypeOf('function');
  });

  it("contributes this host's claude path when PATH has one", async () => {
    const binary = path.join(binDir, 'claude');
    fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 });

    const contribution = await getProviderContainerConfig('claude')!(contextWith(binDir));

    expect(contribution.env?.NANOCLAW_PROVIDER_EXECUTABLE).toBe(binary);
  });

  it('contributes nothing rather than an empty path when PATH has none', async () => {
    // An empty value would reach the runner and override the container
    // default, so the agent would try to exec the empty string.
    const contribution = await getProviderContainerConfig('claude')!(contextWith(binDir));

    expect(contribution.env?.NANOCLAW_PROVIDER_EXECUTABLE).toBeUndefined();
  });

  it('ignores a non-executable file of the right name', async () => {
    fs.writeFileSync(path.join(binDir, 'claude'), 'not a program', { mode: 0o644 });

    const contribution = await getProviderContainerConfig('claude')!(contextWith(binDir));

    expect(contribution.env?.NANOCLAW_PROVIDER_EXECUTABLE).toBeUndefined();
  });

  it('ignores a DIRECTORY of the right name, which carries the execute bit too', async () => {
    // `access(X_OK)` passes on a directory. Handing one to the SDK as
    // `pathToClaudeCodeExecutable` fails inside the child, with a message
    // naming neither this PATH entry nor the resolver.
    fs.mkdirSync(path.join(binDir, 'claude'));

    const contribution = await getProviderContainerConfig('claude')!(contextWith(binDir));

    expect(contribution.env?.NANOCLAW_PROVIDER_EXECUTABLE).toBeUndefined();
  });

  it('keeps looking past a directory and finds a real binary later on PATH', async () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-claude-bin2-'));
    fs.mkdirSync(path.join(binDir, 'claude'));
    const binary = path.join(second, 'claude');
    fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 });

    const contribution = await getProviderContainerConfig('claude')!(
      contextWith(`${binDir}${path.delimiter}${second}`),
    );

    expect(contribution.env?.NANOCLAW_PROVIDER_EXECUTABLE).toBe(binary);
  });
});
