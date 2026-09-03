import { describe, it, expect } from 'bun:test';

import { SDK_DISALLOWED_TOOLS, TOOL_ALLOWLIST, isDisallowedTool } from './claude.js';

// Built-in Claude Code tools whose NAME reads as the obvious way to do
// something NanoClaw already models differently. Leaving one of these
// available is a silent failure: the agent calls the built-in, gets a
// coherent-sounding refusal about a subsystem NanoClaw doesn't use, and
// reports that NanoClaw is broken.
//
// SendMessage is the regression this guards. It addresses Claude Code's own
// in-session subagents; an agent that had just created a NanoClaw agent group
// called it four times and read "No agent named 'growth' is currently
// addressable" as "the group was never provisioned".
const COLLIDES_WITH_NANOCLAW_MCP: Array<[builtin: string, mcpEquivalent: string]> = [
  ['SendMessage', 'mcp__nanoclaw__send_message'],
  ['AskUserQuestion', 'mcp__nanoclaw__ask_user_question'],
];

describe('built-in tools that collide with NanoClaw MCP tools', () => {
  for (const [builtin, mcpEquivalent] of COLLIDES_WITH_NANOCLAW_MCP) {
    it(`${builtin} is disallowed in favour of ${mcpEquivalent}`, () => {
      expect(SDK_DISALLOWED_TOOLS).toContain(builtin);
      expect(TOOL_ALLOWLIST).not.toContain(builtin);
    });
  }

  it('no tool is both allowlisted and disallowed', () => {
    const overlap = TOOL_ALLOWLIST.filter((t) => SDK_DISALLOWED_TOOLS.includes(t));
    expect(overlap).toEqual([]);
  });
});

/**
 * The denylist holds one wildcard, and `Array.includes` could never match it.
 *
 * `mcp__claude_ai_*` is a pattern because the set of account connectors is
 * whatever the human has authorised — it changes with no deploy, so it cannot
 * be enumerated. The PreToolUse hook compared entries literally, which meant
 * the one entry that needed pattern matching was the one entry the hook did
 * not cover.
 *
 * It never bit, because `TOOL_ALLOWLIST` already excludes those namespaces and
 * nothing reached the hook. That is one layer doing the work of two — and the
 * hook exists precisely for the day the first layer is wrong.
 */
describe('the disallowed-tool matcher', () => {
  it('matches a wildcard family the list cannot enumerate', () => {
    expect(isDisallowedTool('mcp__claude_ai_Slack__slack_send_message')).toBe(true);
    expect(isDisallowedTool('mcp__claude_ai_neon__run_sql')).toBe(true);
    // A connector nobody has authorised yet — the reason this is a pattern.
    expect(isDisallowedTool('mcp__claude_ai_SomeFutureApp__do_thing')).toBe(true);
  });

  it('still matches the exact entries', () => {
    expect(isDisallowedTool('SendMessage')).toBe(true);
    expect(isDisallowedTool('AskUserQuestion')).toBe(true);
  });

  it('does not swallow the MCP servers nanoclaw actually wants', () => {
    // The denylist names one family on purpose rather than using strict MCP
    // mode, which would also take code-review-graph and the anya plugin.
    expect(isDisallowedTool('mcp__nanoclaw__send_message')).toBe(false);
    expect(isDisallowedTool('mcp__code-review-graph__query_graph_tool')).toBe(false);
    expect(isDisallowedTool('mcp__plugin_anya-mcp_anya__anya_chat')).toBe(false);
  });

  it('anchors the prefix rather than matching anywhere', () => {
    // A tool merely CONTAINING the family name is a different tool.
    expect(isDisallowedTool('Read')).toBe(false);
    expect(isDisallowedTool('not_mcp__claude_ai_Slack__x')).toBe(false);
  });
});
