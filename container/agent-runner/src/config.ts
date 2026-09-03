/**
 * Runner config — reads `container.json` from AGENT_DIR (see roots.ts) at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';
import path from 'path';

import { AGENT_DIR } from './roots.js';

import type { McpServerConfig } from './providers/types.js';

const CONFIG_PATH = path.join(AGENT_DIR, 'container.json');

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, McpServerConfig>;
  model?: string;
  effort?: string;
  /** API fast serving tier (host-configured; see the host's container-config). */
  fastMode?: boolean;
  /**
   * The repository or worktree this agent stands in, when it is a repo worker.
   * Absent for an ordinary group.
   *
   * PURELY A CWD SELECTOR. It used to do a second job — it was the sole input
   * to `freshSessionPerTask`, which wiped a worker's transcript at the start of
   * every task — and that is gone: a worker resumes like every other session,
   * and autocompact bounds the context the wipe was there to bound.
   */
  workspacePath?: string;
  /**
   * This host's `claude` binary, when the runner executes outside a container.
   * Ignored in a container, which has its own at the SDK's default path.
   */
  hostClaudeExecutable?: string;
}

const DEFAULT_MAX_MESSAGES = 10;

let _config: RunnerConfig | null = null;

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults`);
  }

  _config = {
    provider: (raw.provider as string) || 'claude',
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
    model: (raw.model as string) || undefined,
    effort: (raw.effort as string) || undefined,
    fastMode: raw.fastMode === true || undefined,
    workspacePath: (raw.workspacePath as string) || undefined,
    hostClaudeExecutable: (raw.hostClaudeExecutable as string) || undefined,
  };

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
