/**
 * Slack agent-to-agent (A2A) rooms — the admission policy for bot-authored
 * inbound: room allowlist + consecutive-hop limit + `slack:bot:<bot_id>`
 * re-attribution.
 *
 * The Slack channel layer's bot-inbound guard (src/channels/slack-a2a-guard.ts,
 * installed with the Slack channel) drops every bot-authored inbound message
 * at the bridge boundary by default — sibling and foreign bots never reach the
 * router, so they can neither spam unknown-sender approval cards nor feed each
 * other into loops. The guard exposes a single admission seam
 * (`setBotInboundPolicy`); this module is that policy:
 *
 *   - Rooms allowlisted in `SLACK_A2A_ROOMS` (comma-separated Slack channel
 *     ids, e.g. the MPIM ids printed by scripts/open-a2a-room.ts): bot-authored
 *     inbound is admitted, re-attributed with sender id `slack:bot:<bot_id>`,
 *     under a consecutive-hop limit (`SLACK_A2A_MAX_HOPS`, default 6) that any
 *     human message in the room resets.
 *   - Every other room: bot-authored inbound stays dropped (the guard logs the
 *     drop with this policy's reason).
 *
 * Human-authored messages are structurally outside this policy's power: the
 * guard passes them through untouched and only lets the policy observe them
 * (for the hop-counter reset).
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { setBotInboundPolicy, type SlackBotInboundPolicy } from './slack-a2a-guard.js';

export const DEFAULT_MAX_HOPS = 6;

/** How long a read of SLACK_A2A_ROOMS / SLACK_A2A_MAX_HOPS is cached.
 * Short enough that a room appended to .env by scripts/open-a2a-room.ts is
 * picked up without a service restart. */
const CONFIG_TTL_MS = 30_000;

export interface A2aConfig {
  /** Raw Slack channel ids (C…/G…) allowed to carry bot-authored inbound. */
  rooms: Set<string>;
  /** Consecutive bot-authored inbound messages allowed without a human one. */
  maxHops: number;
}

export function parseRooms(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export function parseMaxHops(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_HOPS;
}

let cached: { at: number; config: A2aConfig } | null = null;

function readA2aConfig(): A2aConfig {
  const now = Date.now();
  if (cached && now - cached.at < CONFIG_TTL_MS) return cached.config;
  const env = readEnvFile(['SLACK_A2A_ROOMS', 'SLACK_A2A_MAX_HOPS']);
  cached = {
    at: now,
    config: {
      rooms: parseRooms(env.SLACK_A2A_ROOMS),
      maxHops: parseMaxHops(env.SLACK_A2A_MAX_HOPS),
    },
  };
  return cached.config;
}

/** The guard reports the adapter's channel id (`slack:C0…`); the allowlist
 * holds raw Slack channel ids. */
/**
 * Cap on tracked thread budgets. A room whose bots chatter and whose humans
 * never speak would otherwise grow one entry per thread forever, since the
 * only eviction is a human's arrival.
 */
const MAX_TRACKED_THREADS = 500;

function roomFromPlatformId(platformId: string): string {
  const idx = platformId.indexOf(':');
  return idx === -1 ? platformId : platformId.slice(idx + 1);
}

/**
 * Build the A2A room policy. The hop counter is per bot identity and per
 * CONVERSATION — keyed on the guard's instanceKey, since each bridge instance
 * is one bot identity, and a bot's own outbound never arrives here (the SDK
 * drops `isMe` upstream). With two bots the effective conversation length is
 * therefore roughly 2×maxHops messages.
 *
 * A conversation is one thread, or — for top-level posts, which Slack names
 * after themselves — the room's shared `root` bucket. Any human message in a
 * room resets EVERY conversation in it for the identity that heard it; every
 * co-hosted identity hears the same human message over its own connection, so
 * the budgets reset together.
 *
 * `getConfig` is injectable for tests; production reads .env with a short TTL
 * cache.
 */
export function createA2aRoomPolicy(getConfig: () => A2aConfig = readA2aConfig): SlackBotInboundPolicy {
  /**
   * Consecutive accepted bot hops, keyed `<instanceKey>:<room>:<thread>` —
   * with every top-level post sharing the literal `root` bucket.
   */
  const hops = new Map<string, number>();

  return {
    decideBotInbound(ctx) {
      const room = roomFromPlatformId(ctx.platformId);
      const { rooms, maxHops } = getConfig();
      if (!rooms.has(room)) {
        return { action: 'drop', reason: 'room not in SLACK_A2A_ROOMS' };
      }
      // PER THREAD, NOT PER ROOM. The budget bounds one runaway exchange, and
      // a room is not an exchange: `#ai-anya` carries a live thread per pull
      // request, so a room-wide key let one PR's review spend the budget for
      // every other PR — and the symptom lands on an innocent thread, which
      // is the hardest place to look.
      //
      // A dropped message still consumes budget, and that is deliberate: the
      // counter bounds BOT CHATTER in a thread, not just bot conversation.
      // `onAccepted` fires once the host's `onInbound` resolves, and the host
      // resolves whether or not an agent engaged — so counting it keeps the
      // guard fail-safe rather than letting a thread nobody serves churn
      // without limit.
      // ROOT POSTS SHARE ONE BUCKET. Slack reports a top-level message's
      // thread id as its OWN timestamp, so keying purely on the thread minted
      // a fresh bucket for every root post and handed each one a full unspent
      // budget — strictly worse than the room-wide key this replaced, because
      // two bots talking at top level would never hit the limit at all.
      //
      // A real thread still gets its own budget, which is the point: one PR's
      // review must not spend the allowance of every other PR in the room.
      const isRoot = ctx.threadId === null || ctx.threadId.endsWith(`:${ctx.message.id}`);
      const key = isRoot ? `${ctx.instanceKey}:${room}:root` : `${ctx.instanceKey}:${room}:${ctx.threadId}`;
      const count = hops.get(key) ?? 0;
      if (count >= maxHops) {
        // The thread is in the log because the budget is per thread: without
        // it an operator can see that something was throttled but not which
        // conversation, which is the diagnosis this key was narrowed to make
        // possible in the first place.
        log.info('slack-a2a: hop limit reached — dropping bot messages until a human speaks', {
          room,
          botId: ctx.botId,
          maxHops,
          conversation: isRoot ? 'root' : ctx.threadId,
        });
        return { action: 'drop', reason: 'hop limit reached' };
      }
      return {
        action: 'admit',
        // The permissions module uses a senderId that already contains a ':'
        // verbatim (see extractAndUpsertUser), so the users row becomes
        // `slack:bot:<bot_id>` — distinguishable from human `slack:U…` ids.
        senderId: `slack:bot:${ctx.botId}`,
        // The guard fires this only after `onInbound` resolves. BE EXACT
        // ABOUT WHAT THAT PROVES: the host's `onInbound` (src/index.ts) calls
        // `routeInbound(...).catch(...)`, so it is fire-and-forget with a
        // swallowing catch and effectively never rejects. In practice budget
        // is therefore consumed on ADMISSION, not on a message having reached
        // a session.
        //
        // The hook is still the right shape — a consumer that does propagate
        // gets the accounting it expects, and the guard should not have to
        // know which one it has — but nothing here should be read as proof
        // that a failed route refunds its hop. Fail-safe is the intent: a
        // thread nobody serves must not churn without limit.
        onAccepted: () => {
          hops.set(key, count + 1);
          // Bounded even in a room no human ever speaks in. Entries are only
          // ever added here, and the reset is a human's arrival — which may
          // never come. Map preserves insertion order, so the oldest thread's
          // budget is the one dropped, and dropping it is safe: a forgotten
          // bucket only ever grants budget back.
          while (hops.size > MAX_TRACKED_THREADS) {
            const oldest = hops.keys().next();
            if (oldest.done) break;
            hops.delete(oldest.value);
          }
        },
      };
    },
    onHumanInbound(ctx) {
      // A human speaking clears every thread's budget in that room, not just
      // the thread they spoke in. The key got narrower; this deliberately did
      // not, because the signal is "a person is here and watching" — and
      // narrowing the reset alongside the key would strand a thread that had
      // already run out, with the human's own message unable to free it.
      const prefix = `${ctx.instanceKey}:${roomFromPlatformId(ctx.platformId)}:`;
      for (const key of hops.keys()) {
        if (key.startsWith(prefix)) hops.delete(key);
      }
    },
  };
}

// Install the policy on the channel layer's guard (single provider — the
// guard warns if another policy was already installed). Runs on barrel
// import, like every channel module's self-registration.
setBotInboundPolicy(createA2aRoomPolicy());
