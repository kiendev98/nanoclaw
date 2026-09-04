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
