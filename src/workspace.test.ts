/**
 * The guard that stops a silent loss of every agent group.
 *
 * State used to be derived from `process.cwd()`. An install that upgrades
 * without moving it would otherwise create an empty database beside a
 * populated checkout and report healthy.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadWorkspace(workspaceDir: string): Promise<typeof import('./workspace.js')> {
  vi.resetModules();
  vi.stubEnv('NANOCLAW_WORKSPACE_DIR', workspaceDir);
  return import('./workspace.js');
}

function tmpDir(stem: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), stem));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('assertWorkspaceMigrated', () => {
  it('stops when the checkout holds the database and the workspace does not', async () => {
    const projectRoot = tmpDir('ncl-legacy-');
    fs.mkdirSync(path.join(projectRoot, 'data'));
    fs.writeFileSync(path.join(projectRoot, 'data', 'v2.db'), '');

    const { assertWorkspaceMigrated } = await loadWorkspace(tmpDir('ncl-ws-'));

    // The message must carry the move, not just the diagnosis.
    expect(() => assertWorkspaceMigrated(projectRoot)).toThrow(/cp -R /);
  });

  it('names only the trees the checkout actually holds', async () => {
    const projectRoot = tmpDir('ncl-legacy-');
    fs.mkdirSync(path.join(projectRoot, 'data'));
    fs.writeFileSync(path.join(projectRoot, 'data', 'v2.db'), '');

    const { assertWorkspaceMigrated } = await loadWorkspace(tmpDir('ncl-ws-'));

    // Naming an absent tree sends the operator to fix a copy never needed.
    expect(() => assertWorkspaceMigrated(projectRoot)).toThrow(/data\/\./);
    expect(() => assertWorkspaceMigrated(projectRoot)).not.toThrow(/groups\/\./);
  });

  it('starts when the workspace holds the database', async () => {
    const projectRoot = tmpDir('ncl-legacy-');
    fs.mkdirSync(path.join(projectRoot, 'data'));
    fs.writeFileSync(path.join(projectRoot, 'data', 'v2.db'), '');

    const workspaceDir = tmpDir('ncl-ws-');
    fs.mkdirSync(path.join(workspaceDir, 'data'));
    fs.writeFileSync(path.join(workspaceDir, 'data', 'v2.db'), '');
    const { assertWorkspaceMigrated } = await loadWorkspace(workspaceDir);

    expect(() => assertWorkspaceMigrated(projectRoot)).not.toThrow();
  });

  it('starts on a fresh install, where neither holds one', async () => {
    const { assertWorkspaceMigrated } = await loadWorkspace(tmpDir('ncl-ws-'));

    expect(() => assertWorkspaceMigrated(tmpDir('ncl-legacy-'))).not.toThrow();
  });

  it('derives every host-owned tree from the one root', async () => {
    const workspaceDir = tmpDir('ncl-ws-');
    const ws = await loadWorkspace(workspaceDir);

    expect(ws.GROUPS_DIR).toBe(path.join(workspaceDir, 'groups'));
    expect(ws.DATA_DIR).toBe(path.join(workspaceDir, 'data'));
    expect(ws.STORE_DIR).toBe(path.join(workspaceDir, 'store'));
  });
});
