/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All message IO goes through the registered mailbox.
 *
 * Config is read from <AGENT_DIR>/container.json. Only TZ and OneCLI
 * networking vars come from env.
 *
 * Every root below resolves through `roots.ts`, NOT through the literal paths
 * shown here. The container paths are the defaults; a host run overrides each
 * one with an env var, because the container layout nests `/workspace/agent`
 * inside `/workspace` while the two map to unrelated host directories. Never
 * hardcode one of these — see the attachment-path bug that shipped from
 * exactly that (`formatter.ts`, `formatAttachments`).
 *
 * Layout, with the container default and its override:
 *   /workspace/                   NANOCLAW_WORKSPACE_DIR
 *     mailbox state               ← selected implementation
 *     .heartbeat                  ← touched for liveness detection
 *     outbox/                     ← outbound files
 *     inbox/<messageId>/          ← received attachments, written by the host
 *     agent/                      NANOCLAW_AGENT_DIR — the group folder (state only)
 *       CLAUDE.md                 ← composed project document
 *       container.json            ← per-group config
 *       memory/                   ← persistent memory tree
 *     extra/                      NANOCLAW_EXTRA_DIR — operator mounts
 *   /app/.nanoclaw-session.json   NANOCLAW_SESSION_CONTEXT_PATH
 *   /app/src/                     ← agent-runner source (container only)
 *   /app/skills/                  ← shared skills (container only)
 *   /home/node/.claude/           ← SDK state (container only; a host run uses $HOME)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
import { getTaskSeriesId } from './db/session-routing.js';
import { ensureMemoryScaffold } from './memory/scaffold.js';
import { MEMORY_SESSION_HOOK } from './memory/session-hook.js';
// Module barrel — loads registration modules, including the singular mailbox slot.
import './modules/index.js';
import { getAgentMailbox, readMailboxContext } from './mailbox/index.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { resolvePluginServer } from './plugin-mcp.js';
import type { McpServerConfig } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';
import { AGENT_DIR, EXTRA_DIR, PROJECT_DIR } from './roots.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

/**
 * The directory the agent stands in.
 *
 * PROJECT_DIR, not AGENT_DIR. cwd is the only thing that decides which
 * project's CLAUDE.md, `.claude/skills/` and `.claude/settings.json` a session
 * loads — Claude Code walks UP from cwd for all three — so for a repo worker it
 * has to be the worktree. `roots.ts` already defaults PROJECT_DIR to AGENT_DIR,
 * so an ordinary group is unaffected: same value, same behaviour as before.
 *
 * Reading AGENT_DIR here silently defeated the whole worker-workspace feature.
 * The host resolved the worktree correctly at every step — created it, stored
 * `agent_groups.workspace_path`, exported `NANOCLAW_PROJECT_DIR`, and pointed
 * the spawn's own cwd at it via `resolveSpawnCwd` — and then this line handed
 * the SDK the group folder anyway.
 *
 * It failed silently rather than loudly because a group folder lives INSIDE a
 * repository (saber, for this install). So `git rev-parse --show-toplevel`
 * walked up out of the group folder and returned that repository: a valid root,
 * a valid branch, real commits, all of them the wrong ones. A worker asked for
 * `wego-ai` reported saber and never noticed. Worse, a write would have landed
 * on the shared checkout's `main` instead of the worker's own branch, so the
 * isolation the worktree exists to provide was not real.
 *
 * AGENT_DIR stays the agent's STATE directory — memory and footer telemetry
 * must not follow cwd into a repository.
 */
const CWD = PROJECT_DIR;

/** The flat instruction file the host composes into AGENT_DIR on every spawn. */
const PROJECT_DOC = 'CLAUDE.md';

/**
 * The composed project document, for a worker only, as system-prompt text.
 *
 * Claude Code discovers this file by walking UP from cwd. An ordinary group's
 * cwd IS the group folder, so the walk finds it and this returns nothing.
 * A worker's cwd is its worktree, somewhere under `~/.config/nanoclaw/worktrees`
 * — the walk never passes through AGENT_DIR and the document is simply absent.
 *
 * `additionalDirectories` does NOT cover this. It grants the tools permission to
 * read a path; it does not load a CLAUDE.md as project memory. Verified against
 * the real CLI: `claude -p --add-dir <dir-holding-CLAUDE.md>` from an unrelated
 * cwd cannot see its contents, while running with cwd set to that directory can.
 * Relying on it would have shipped a worker with no persona, no runtime
 * contract, no destinations map and no `ncl` instructions — silently, because an
 * agent missing its instructions still answers, just generically.
 *
 * Injecting it is exact rather than approximate: the host already inlines every
 * instruction source into this one flat file with no imports
 * (`project-doc-compose.ts`), which is the same content the walk would have
 * loaded. Cost is identical too — it is the same bytes in the same context.
 *
 * Fails soft. A worker with no document is worse off, but so is a worker whose
 * runner refused to start.
 */
function workerProjectDoc(): string {
  if (PROJECT_DIR === AGENT_DIR) return '';
  const docPath = path.join(AGENT_DIR, PROJECT_DOC);
  let body: string;
  try {
    body = fs.readFileSync(docPath, 'utf-8').trim();
  } catch {
    log(`No project document at ${docPath} — continuing without it`);
    return '';
  }
  if (!body) return '';
  // Anchored absolutely, because the document's own prose says things like
  // "beside `memory/` in your agent folder" and every relative path in it would
  // otherwise resolve into the repository worktree — leaving a stray
  // `instructions.prepend.md` inside a git checkout while the real persona file
  // is never touched.
  return [
    `Your agent state directory is \`${AGENT_DIR}\`. Every path below that is`,
    'described as being in "your agent folder" lives there, NOT in your current',
    'working directory, which is a repository worktree you are working in.',
    '',
    body,
  ].join('\n');
}

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;
  const mailbox = getAgentMailbox();
  await mailbox.start(await readMailboxContext());

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Every provider shares one persistent memory tree. Legacy imports are an
  // operator-run migration and never happen in this normal startup path.
  ensureMemoryScaffold();

  // Runtime-generated system-prompt addendum: agent identity (name) plus
  // the live destinations map. Everything else (capabilities, per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md — one flat file the host composes per spawn
  // with every instruction source inlined, no imports. Memory is supplied
  // separately by each provider's native lifecycle hook.
  const taskId = getTaskSeriesId();
  const addendum = buildSystemPromptAddendum(
    config.assistantName || undefined,
    taskId ? { kind: 'task', taskId } : { kind: 'chat' },
  );
  const instructions = [addendum, workerProjectDoc()].filter(Boolean).join('\n\n');

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  // A worker stands in its worktree, so AGENT_DIR is no longer on the path
  // Claude Code walks up from cwd. It still has to be reachable: the composed
  // CLAUDE.md the host writes per spawn lives there, and so does the memory
  // tree. Added only when the two differ, so an ordinary group passes exactly
  // the list it passed before.
  if (PROJECT_DIR !== AGENT_DIR && fs.existsSync(AGENT_DIR)) additionalDirectories.push(AGENT_DIR);
  const extraBase = EXTRA_DIR;
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: nanoclaw built-in + any from container.json
  const mcpServers: Record<string, McpServerConfig> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
  };

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    // Plugin-shipped servers get ${PLUGIN_ROOT}/${PLUGIN_DATA} expansion and
    // the two injected env vars; everything else passes through untouched.
    mcpServers[name] = resolvePluginServer(serverConfig);
    log(
      serverConfig.type === 'http'
        ? `Additional MCP server: ${name} (HTTP)`
        : `Additional MCP server: ${name} (${serverConfig.command})`,
    );
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
    model: config.model,
    effort: config.effort,
    fastMode: config.fastMode,
  });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

  try {
    await runPollLoop({
      provider,
      providerName,
      cwd: CWD,
      systemContext: { instructions },
    });
  } finally {
    await mailbox.stop();
  }
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
