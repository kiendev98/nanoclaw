import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A claude.ai connector is OAuth'd to the operator's personal account, so the
// bot calling one authenticates as the human rather than as itself. The failure
// this pins is silent in both directions. Drop `BOT_ISOLATION_SETTINGS` and the
// bot loads every connector again, which one measured spawn showed costing
// 89,861 tokens. Widen it to `strictMcpConfig` and the bot also loses
// `code-review-graph` and its plugin servers. Those arrive from user settings
// and plugins, not from `mcpServers`, which strict mode keeps.
// See docs/blueprints/nanoclaw/MCP-ISOLATION.md.

let lastOptions: Record<string, unknown> | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: Record<string, unknown> }) => {
    lastOptions = args.options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-mcp' };
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

const OWN_SERVER = { type: 'stdio' as const, command: 'echo', args: ['hi'] };

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  lastOptions = undefined;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-connectors-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function drive(options: ConstructorParameters<typeof ClaudeProvider>[0]): Promise<void> {
  const provider = new ClaudeProvider(options);
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  for await (const _ of q.events) {
    /* drain */
  }
}

describe('claude.ai connectors are gated for every session', () => {
  it('sends disableClaudeAiConnectors when fast mode is off', async () => {
    await drive({});
    expect(lastOptions?.settings).toMatchObject({ disableClaudeAiConnectors: true });
  });

  it('sends disableClaudeAiConnectors when fast mode is on', async () => {
    await drive({ fastMode: true });
    expect(lastOptions?.settings).toMatchObject({ disableClaudeAiConnectors: true });
  });

  it('leaves the provider its own mcp servers', async () => {
    await drive({ mcpServers: { ownServer: OWN_SERVER } });
    expect(Object.keys(lastOptions?.mcpServers as Record<string, unknown>)).toEqual(['ownServer']);
  });

  it('does not reach for strictMcpConfig, which would drop those servers too', async () => {
    await drive({ mcpServers: { ownServer: OWN_SERVER } });
    expect(lastOptions && 'strictMcpConfig' in lastOptions).toBe(false);
  });

  it('leaves the settingSources chain untouched', async () => {
    await drive({});
    expect(lastOptions?.settingSources).toEqual(['project', 'user', 'local']);
  });
});
