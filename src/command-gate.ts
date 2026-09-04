/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
 * - Normal messages: pass through unchanged
 */
import { hasAdminPrivilege } from './modules/permissions/db/user-roles.js';

export type GateResult = { action: 'pass' } | { action: 'filter' } | { action: 'deny'; command: string };

const FILTERED_COMMANDS = new Set(['/start', '/help', '/login', '/logout', '/doctor', '/config', '/remote-control']);
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files', '/upload-trace']);

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'pass' for normal messages and authorized admin commands,
 * 'filter' for silently-dropped commands, 'deny' for unauthorized
 * admin commands.
 */
export async function gateCommand(content: string, userId: string | null, agentGroupId: string): Promise<GateResult> {
  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = (parsed.text || '').trim();
  } catch {
    text = content.trim();
  }

  if (!text.startsWith('/')) return { action: 'pass' };

  const command = text.split(/\s/)[0].toLowerCase();

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (ADMIN_COMMANDS.has(command)) {
    if (await isAdmin(userId, agentGroupId)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them)
  return { action: 'pass' };
}

/**
 * True when this text dispatches a command the container acts on.
 *
 * The two sets above hold every command the gate classifies, and their union is
 * identical to the two sets the agent-runner formatter carries. The runner also
 * reads any text that starts with `/clear` as a clear, so a prefix match on that
 * one catches `/clearall` too.
 *
 * A door that returns before `gateCommand` runs must still refuse what the gate
 * would have refused, and it calls this to do so.
 */
export function isGatedCommand(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed.startsWith('/')) return false;
  if (trimmed.startsWith('/clear')) return true;
  const command = trimmed.split(/\s/)[0];
  return FILTERED_COMMANDS.has(command) || ADMIN_COMMANDS.has(command);
}

async function isAdmin(userId: string | null, agentGroupId: string): Promise<boolean> {
  if (!userId) return false;
  return hasAdminPrivilege(userId, agentGroupId);
}
