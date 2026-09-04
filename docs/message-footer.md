# Message footer

A one-line telemetry footer is appended to delivered chat messages:

```
Wego #1 · opus-5[1m] · think: high · ctx: 84k · 5h: 31% · 7d: 12%
```

Every field is omitted when its source has not reported yet. A fresh session
degrades rather than printing zeros it cannot stand behind. A footer that
invents a number is worse than no footer.

## Why ctx is a token count, not a percentage

A percentage needs a denominator, and this one was not trustworthy. The CLI's
own model table gives `claude-opus-5` a 1e6 window. A live session reported
`maxTokens` and `rawMaxTokens` both at 165,000. Those are the same variable, so
the pair cannot distinguish a cap from a raw limit.

84k rendered as "51%" invited a reasonable reader to conclude that a greeting
had consumed half a megatoken. The absolute count needs no such trust.

## Why the account is the organisation, not the email

The two subscriptions this runs against share one login and one accountUuid, in
two different organisations. Email cannot tell them apart.

The config directory could tell them apart. It names claude-swap's plumbing
rather than the thing the reader is asking about, which is: which subscription
is this turn spending?

## Why it appends to every message, not only the last

With a provider that streams text, `dispatchResultText` runs with
`suppressDelivery`. Every message is delivered mid-turn, as its block is parsed,
and the result door sends nothing.

So at the moment the turn ends, no final row is left to decorate. The rows are
already written, and the host may already have delivered them. Rewriting one
after the fact is a race against the outbound poller.

The usual turn sends exactly one message. There, per-message and per-turn are
the same thing.

## Where the organisation name comes from

`CLAUDE_CONFIG_DIR` is read per call rather than captured at import, because
claude-swap sets it per process and this module may load before it does. The
resolved value is cached after the first successful read, because the
organisation cannot change under a running session without the process being
replaced.

When the variable is unset, the config file is `~/.claude.json`, a SIBLING of
`~/.claude` rather than a file inside it. When it is set, the file lives inside
the named directory. Getting that wrong reads nothing and silently drops the
field.

## Why the group blob is written through a rename

Sessions of one agent group run concurrently, and each holds the whole blob. A
partial write seen by a sibling would drop a window it never observed itself. So
the write goes through a randomly-named temp file and a rename.

`wx` refuses an existing path, so a collision fails rather than following a
symlink the agent could have planted. The group folder is writable by the agent.

## Why two stores

`contextTokens` is this conversation's occupancy, and it is session-scoped.
Sharing it would show one thread's context inside another.

`windows` is the utilization of the ACCOUNT's rate-limit windows. It was
session-scoped in the first cut, and that is why a new thread's first message
rendered nothing for 5h/7d. A fresh session starts with an empty blob, and a
`rate_limit_event` only fires when a value changes. It now lives in one file in
the group folder, shared by every session of the agent group.

## Where the code lives

| Module | Concern |
|---|---|
| `telemetry/state.ts` | what the turn knows about itself — providers write, nothing else does |
| `telemetry/persistence.ts` | the two stores, session and group. No state, no decisions |
| `telemetry/footer.ts` | rendering one line from a snapshot |
| `providers/claude-telemetry.ts` | the three things only Claude knows |
| `src/channels/message-footer.ts` | the field's shape on the host side of the boundary |

The split follows the callers: `providers/claude.ts` calls seven recorders and
`poll-loop.ts` calls `renderFooter`, so collection and rendering never had the
same consumer.

No provider vocabulary lives in `telemetry/`. Three things only a provider can
know arrive through a `register*` call at import:

| Registered | What Claude supplies |
|---|---|
| `registerRateLimitWindows` | `five_hour`, `seven_day_opus`, and their labels |
| `registerModelShortener` | strips the `claude-` prefix and the date suffix |
| `registerAccountResolver` | reads the organisation from `~/.claude.json` |

Unregistered defaults are inert, not wrong: no windows render, a model id
renders as-is, and no account field appears. A second provider inherits none of
Claude's assumptions.

## The field crossing the boundary

The runner writes `footer` beside `text` on the outbound content blob.
`OutboundMessage.content` is `unknown` by design — the host does not own what a
provider puts there — so no compiler enforces the field.

`src/channels/message-footer.ts` holds the contract instead. An adapter reads
`readFooter(content)`, then either renders it separately or falls back to
`appendFooter`. An adapter that does neither drops the footer silently, which is
what every adapter on the `channels` branch does today.
