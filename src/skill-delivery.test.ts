/**
 * Skill delivery — the two routes a group's selected skills take to an agent.
 *
 * Both are exercised here because the difference between them is the point:
 * one plants container paths, the other plants real host paths, and a session
 * that gets the wrong one loses every shared skill in silence.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContainerConfig } from './container-config.js';
import { resetGatewayProvider } from './gateway-providers/index.js';
import { log } from './log.js';
import { selectedSkillNames, stageSkillsPlugin, syncSkillSymlinks } from './skill-delivery.js';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

function useGateway(injectsCredentials: boolean): void {
  resetGatewayProvider({
    kind: injectsCredentials ? 'fake-proxy' : 'fake-direct',
    injectsCredentials,
    contribute: async () => ({}),
  });
}

beforeEach(() => useGateway(true));
afterEach(() => resetGatewayProvider(null));

const containerConfig: ContainerConfig = {
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: [],
  skills: [],
} as unknown as ContainerConfig;

describe('syncSkillSymlinks', () => {
  function tmpClaudeDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-skills-'));
  }

  it('links every selected skill to its container path', () => {
    const dir = tmpClaudeDir();
    syncSkillSymlinks(dir, { ...containerConfig, skills: ['welcome'] } as ContainerConfig);

    const link = path.join(dir, 'skills', 'welcome');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    // Dangling on the host, valid inside the container.
    expect(fs.readlinkSync(link)).toBe('/app/skills/welcome');
  });

  it('prunes symlinks that are no longer selected', () => {
    const dir = tmpClaudeDir();
    syncSkillSymlinks(dir, { ...containerConfig, skills: ['welcome', 'vercel-cli'] } as ContainerConfig);
    syncSkillSymlinks(dir, { ...containerConfig, skills: ['welcome'] } as ContainerConfig);

    expect(fs.existsSync(path.join(dir, 'skills', 'vercel-cli'))).toBe(false);
  });

  it('warns instead of silently skipping when a real entry blocks a desired skill', () => {
    // Template overlays depend on surviving the prune (see src/group-skills.ts);
    // a stale pre-refactor skill copy (#3001) otherwise gets served forever with
    // no trace.
    const dir = tmpClaudeDir();
    fs.mkdirSync(path.join(dir, 'skills', 'welcome'), { recursive: true });

    syncSkillSymlinks(dir, { ...containerConfig, skills: ['welcome'] } as ContainerConfig);

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Shared skill not symlinked'),
      expect.objectContaining({ skill: 'welcome' }),
    );
  });
});

describe('stageSkillsPlugin', () => {
  function tmpSessionDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-plugin-'));
  }

  it('writes a plugin manifest the provider can load by path', () => {
    const sessDir = tmpSessionDir();
    stageSkillsPlugin(sessDir, { ...containerConfig, skills: ['welcome'] } as ContainerConfig);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(sessDir, 'plugin', '.claude-plugin', 'plugin.json'), 'utf-8'),
    );
    expect(manifest.name).toBe('nanoclaw-shared-skills');
  });

  it('links each skill to its real host path, not a container path', () => {
    // The whole point of the plugin route: a host process cannot resolve
    // `/app/skills`, which is what the symlink route plants.
    const sessDir = tmpSessionDir();
    stageSkillsPlugin(sessDir, { ...containerConfig, skills: ['welcome'] } as ContainerConfig);

    const link = path.join(sessDir, 'plugin', 'skills', 'welcome');
    expect(fs.readlinkSync(link)).toBe(path.join(process.cwd(), 'container', 'skills', 'welcome'));
  });

  it('drops a skill that left the selection', () => {
    const sessDir = tmpSessionDir();
    stageSkillsPlugin(sessDir, { ...containerConfig, skills: ['welcome', 'agent-browser'] } as ContainerConfig);
    stageSkillsPlugin(sessDir, { ...containerConfig, skills: ['welcome'] } as ContainerConfig);

    expect(fs.existsSync(path.join(sessDir, 'plugin', 'skills', 'agent-browser'))).toBe(false);
  });

  it('skips a selected skill that does not exist rather than throwing', () => {
    const sessDir = tmpSessionDir();
    stageSkillsPlugin(sessDir, { ...containerConfig, skills: ['no-such-skill'] } as ContainerConfig);

    expect(fs.existsSync(path.join(sessDir, 'plugin', 'skills', 'no-such-skill'))).toBe(false);
  });
});

describe('selectedSkillNames', () => {
  // The delivery routes and the composed project document read this one list,
  // so a skill the gateway cannot support must leave from here.
  it('drops a credential skill when the gateway injects nothing', () => {
    useGateway(false);

    const names = selectedSkillNames({
      ...containerConfig,
      skills: ['onecli-gateway', 'welcome'],
    } as ContainerConfig);

    expect(names).toEqual(['welcome']);
  });

  it('keeps a credential skill when the gateway injects credentials', () => {
    const names = selectedSkillNames({
      ...containerConfig,
      skills: ['onecli-gateway', 'welcome'],
    } as ContainerConfig);

    expect(names).toEqual(['onecli-gateway', 'welcome']);
  });

  it('drops it from the shipped catalog too, not only a named selection', () => {
    useGateway(false);

    const names = selectedSkillNames({ ...containerConfig, skills: 'all' } as unknown as ContainerConfig);

    expect(names).not.toContain('onecli-gateway');
    expect(names).toContain('welcome');
  });
});
