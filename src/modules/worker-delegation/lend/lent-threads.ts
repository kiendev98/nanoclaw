/**
 * The threads workers are currently holding.
 *
 * A lent conversation is a deliberate bot-to-bot loop, and a channel's
 * bot-admission cap would otherwise stop it mid-review. The claim is made here
 * and asked for by the channel, so this module names no channel adapter — one
 * of which ships as a skill payload and would take the build with it.
 *
 * In memory, mirroring the cap's own bookkeeping: a host restart re-arms the
 * cap on a thread that was exempt, which fails toward the bound.
 */
function key(channelType: string, platformId: string, threadId: string): string {
  return `${channelType} ${platformId} ${threadId}`;
}

const lentThreads = new Set<string>();

export function rememberLentThread(channelType: string | null, platformId: string | null, threadId: string): void {
  if (!channelType || !platformId) return;
  lentThreads.add(key(channelType, platformId, threadId));
}

export function forgetLentThread(channelType: string, platformId: string, threadId: string): void {
  lentThreads.delete(key(channelType, platformId, threadId));
}

export function isLentThread(channelType: string, platformId: string, threadId: string): boolean {
  return lentThreads.has(key(channelType, platformId, threadId));
}
