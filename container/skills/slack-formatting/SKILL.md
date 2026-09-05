---
name: slack-formatting
description: Format messages for Slack using standard Markdown. Use when responding to Slack channels (folder starts with "slack_" or JID contains slack identifiers).
---

# Slack Message Formatting

Write **standard Markdown** for Slack. Do not write Slack's classic mrkdwn.

## Why this dialect, and not mrkdwn

NanoClaw sends every Slack message through `chat-sdk-bridge.ts` as `{ markdown }`.
The Slack adapter maps that to the API's `markdown_text` field. Its own source
says so: *"Render an AST to standard markdown. Slack accepts this directly via
`markdown_text` and the `markdown` block."*

Classic mrkdwn reaches Slack only on the `text` field, which this transport
never uses. So mrkdwn syntax arrives as broken literal text.

Observed: a report written with `<url|label>` links produced one mangled link
that swallowed the next line's label, and two of its three links were dead.

Do not change these rules back to `*bold*` and `<url|text>` without first
checking which field `chat-sdk-bridge.ts` sends.

## Formatting reference

### Text styles

| Style | Syntax | Note |
|-------|--------|------|
| Bold | `**text**` | A single `*` is italic, not bold |
| Italic | `_text_` or `*text*` | |
| Strikethrough | `~~text~~` | |
| Code (inline) | `` `code` `` | |
| Code block | ` ```code``` ` | |

### Links

```
[Link text](https://example.com)     # Named link
https://example.com                  # Bare URL, auto-linked
```

### Slack entities

These are Slack references rather than Markdown, and they keep their own
syntax:

```
<@U1234567890>     # Mention a user by ID
<#C1234567890>     # Mention a channel by ID
<!here>            # @here
<!channel>         # @channel
```

### Lists

```
- First item
- Second item

1. First step
2. Second step
```

### Block quotes

```
> This is a block quote
> It can span multiple lines
```

### Emoji

Use standard emoji shortcodes: `:white_check_mark:`, `:x:`, `:rocket:`, `:tada:`

## What NOT to use

- **NO** `*single asterisks*` for bold — that is italic here, so bold needs `**`
- **NO** `<url|text>` links — this is mrkdwn, and it renders as broken text
- **NO** `~single tildes~` for strikethrough — use `~~double~~`

## Rendering is Slack's, not yours

Write correct standard Markdown and let Slack render what it supports. Slack
flattens some constructs. A heading may arrive as bold text, and a table may
arrive as plain lines. Neither is a reason to write mrkdwn instead.

Prefer short paragraphs, bold labels, and bullets. They survive every renderer.

## Example message

```
**Daily Standup Summary**

_March 21, 2026_

- **Completed:** Fixed authentication bug in login flow
- **In Progress:** Building new dashboard widgets
- **Blocked:** Waiting on API access from DevOps

> Next sync: Monday 10am

:white_check_mark: All tests passing | [View Build](https://ci.example.com/builds/123)
```

## Quick rules

1. Use `**bold**`, never `*bold*`
2. Use `[text](url)`, never `<url|text>`
3. Keep `<@U…>` and `<#C…>` for Slack mentions
4. Use `:emoji:` shortcodes
5. Quote blocks with `>`
