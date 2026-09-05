/**
 * Determine whether a platform ID needs a channel-type prefix.
 *
 * Chat SDK adapters (Telegram, Discord, Slack, Teams, etc.) namespace their
 * platform IDs with a channel prefix: "telegram:123456", "discord:guild:chan".
 * The router stores channel_type and platform_id in separate columns, but
 * Chat SDK adapters send the prefixed form as the platform_id — so any code
 * that writes messaging_groups rows must produce the same shape the adapter
 * will later emit as event.platformId, or router lookups miss and messages
 * get silently dropped.
 *
 * Native adapters (Signal, WhatsApp, iMessage, DeltaChat) use their own ID
 * formats and send them as-is — no channel prefix. WhatsApp/iMessage emit
 * JIDs/emails containing '@'. Signal emits raw phone numbers ('+15551234567')
 * for DMs and 'group:<id>' for group chats. DeltaChat emits numeric chat IDs
 * ('12'). Prefixing any of these would cause a mismatch with what the adapter
 * later emits.
 */
export function namespacedPlatformId(channel: string, raw: string): string {
  if (raw.startsWith(`${channel}:`)) return raw;
  if (raw.includes('@')) return raw;
  if (raw.startsWith('+') || raw.startsWith('group:')) return raw;
  if (channel === 'deltachat') return raw;
  return `${channel}:${raw}`;
}

/**
 * The thread id an adapter addresses, built from the platform id of the chat
 * and the raw id of the message that opened the thread.
 *
 * A Chat SDK adapter emits and accepts `<platform id>:<raw message id>`, and
 * `channelIdFromThreadId` inverts exactly that. Posting returns the raw id
 * alone, so anything that keeps a thread id from a post it made has to build
 * the rest. An adapter refuses the raw id, because it decodes an id it never
 * encoded.
 *
 * Native adapters carry no channel prefix and their own thread shapes, which
 * this rule does not know. Their ids pass through untouched.
 *
 * @param platformId The chat address, as the adapter emits it.
 * @param rawMessageId The id the platform gave the message that opened the
 * thread. An id already carrying the platform prefix is returned unchanged.
 */
export function qualifiedThreadId(platformId: string, rawMessageId: string): string {
  if (!platformId.includes(':')) return rawMessageId;
  if (rawMessageId.startsWith(`${platformId}:`)) return rawMessageId;
  return `${platformId}:${rawMessageId}`;
}
