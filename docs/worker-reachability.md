# Worker Reachability

An agent that has stepped away from the human still has to be reachable. This
document covers the three parts of that: a session recognising its own thread, a
worker asking a question when no human can hear it, and a worker holding a
conversation in a channel it does not own.

**All three sections are now built.** Section 1 is on `main`; sections 2 and 3
were specified here first and then implemented against this document, so every
diagram below describes working code. What is still open is listed under
**Known limits** at the end, not marked inline.

| Section | Status |
|---|---|
| 1 — Thread binding, escalated questions (v1), retryable spawn | **SHIPPED** |
| 2 — `answer_worker` and the typed answer | **SHIPPED** |
| 3 — Worker on a channel (pr-babysit) | **SHIPPED** |

Diagram convention: `░` marks a blocked tool call, `╳` marks a container going
idle, and time runs downward.

---

# 1. What ships today

## 1.1 A worker reports once, and the runner writes it

A worker never calls a tool to report. Every `result` event overwrites
`pendingLaneReport`, and the runner delivers the last one at stream close.

```
   USER            ORCHESTRATOR              WORKER
     ├─ "fix login" ────►│                     │
     │                   ├─ spawn_worker ─────►│  brief delivered
     │                   │              ┌──────┴──────┐
     │                   │              │ works       │  each `result`
     │                   │              │ result ─────┼─► overwrites
     │                   │              │ result ─────┼─► pendingLaneReport
     │                   │              └──────┬──────┘
     │                   │                     │  stream CLOSES
     │                   │              ┌──────┴──────┐
     │                   │              │ RUNNER CODE │  poll-loop.ts
     │                   │              │ deliverOn   │  NOT a tool call
     │                   │              │ AgentLane() │
     │                   │              └──────┬──────┘
     │                   │◄────────────────────┤
     │◄─ "done" ─────────┤                     ╳
```

`result` events are turn boundaries, not completions — the SDK emits exactly one
per turn and there is no `is_final` flag. Buffering and delivering the last one
is what makes "the final turn" different from "every turn".

## 1.2 A session answers inside the thread it opened

The bot posts, the post becomes a thread, someone replies in it — and the bot
does not recognise its own thread, because `resolveSession` keys on
(agent group, messaging group, thread) and that thread has never been seen. A
brand new session answers a conversation it knows nothing about.

```
   ai-anya (Slack)              ORCHESTRATOR session S_A
        │◄─ send_message, thread=null ─┤
        │   TOP-LEVEL → thread T, root R
        │                       ┌──────┴──────┐
        │                       │ HOOK 1      │  after a SUCCESSFUL send
        │                       │ bind(mg, R) │  only a ROOT post binds
        │                       └──────┬──────┘
        ├─ Anya replies in T ─────────►│
        │   HOOK 2: root R → binding → S_A
        │           gated on agent_group_id
        │   SAME session, full transcript
```

| Hook | File | Where |
|---|---|---|
| 1 | `delivery.ts` | after a successful send — a message that named no thread *opened* one, so its delivered id is that thread's root |
| 2 | `session-manager.ts` | first statement inside `resolveSession`'s lock, ahead of every other lookup |

### There is deliberately no third hook

An earlier revision also redirected any thread-less *outbound* into the bound
thread. It was removed, and the reason matters because it will look like an
omission:

A `shared`-mode session's `thread_id` is always null, every MCP tool copies that
null onto its outbound, and the binding is first-wins with nothing that clears
it — no TTL, no `ncl` verb, and `/clear` resets the continuation but not the
binding. So the first thread such a session ever opened captured every later
question card and proactive post for the life of the session. A daily digest
threaded under day one.

Nothing was lost by removing it. A reply to a human's thread reply already
resolves through `getLatestInboundRoute` in the container. The redirect's only
unique case was the proactive send with no preceding inbound — exactly where
threading into an old conversation is wrong.

### Three decisions worth knowing

**Only a root post binds.** A reply carries its own message id, which names no
thread — measured live, a reply into the thread rooted at `…925.613579` came
back as `1788370933.675069`. Binding on every delivery would store a key no
inbound thread can ever match, and would fail silently.

**Matching parses; only replying composes.** A wrong guess when composing posts
at top level, which a human sees at once. A wrong guess when matching silently
mints the second session this exists to prevent.

**First-wins, not last-wins.** A session's second top-level post in another
channel must not steal the binding from the thread people are already replying
in. That second thread stays unbound; a table is the migration to write the day
that case is real.

Migration 028 is idempotent per column via a caught `duplicate column name`
rather than `pragma_table_info`, because migrations past the portability
boundary must run on any driver and PRAGMA is banned from them.

## 1.3 A worker asks its orchestrator

A repo worker owns no channel. Its only address is the lane back to the
orchestrator that spawned it, and `ask_user_question` did not know that. The
card went down that lane and failed three times over, silently each time:

| where | what happened |
|---|---|
| `performAgentRoute` | copies the row in as `kind: 'chat'`; the formatter renders `content.text`, a card has none → the orchestrator woke to an empty message |
| `delivery.ts` | `channel_type === 'agent'` returns *before* the `pending_questions` insert → no button existed anywhere |
| the tool | polled for a response that could not arrive → blocked 300 s, then "timed out" |

Today the tool blocks, sets a short-lived liveness flag, and claims the first
chat row that arrived after the question and carries text. Section 2 replaces
that mechanism; the escalation itself is unchanged.

**The lane decides, not the group.** `writeSessionRouting` splits on
`session.messaging_group_id`: a session belonging to a chat routes to that
channel and thread, one belonging to none routes down the agent lane. So
`channel_type === 'agent'` is not a test for "am I a worker" — it is the test for
**"is there a person at the other end of my only address"**.

**The 600 s bound exists because nothing can see a human.** Claude Code's
`askUserQuestionTimeout` defaults to `never` because it can see someone at a
terminal. Here the host kills a container whose heartbeat is 30 minutes stale.
600 s is longer than the 300 s channel bound because this round trip may
*contain* that one.

## 1.4 A failed `spawn_worker` is retryable

The repo name comes from a chat message, so a mistyped one is the ordinary
failure. The refusal named the allowed roots — what an operator needs — but the
caller is an agent that cannot list them.

```
   USER            ORCHESTRATOR                    HOST
     ├─ "check sabre" ──►│                          │
     │                   ├─ spawn_worker("sabre") ─►│ resolveRepo ✗
     │                   │◄─ 'Repositories you can name:
     │                   │    saber, wego/nanoclaw' │
     │                   │    'safe to retry'       │
     │                   ├─ spawn_worker("saber") ─►│ ✓
```

Two refusals deliberately do not list: an absolute path or a `..` segment is
refused on *shape*, and an empty allowlist is an operator problem the caller
cannot retry past.

**What this discloses, deliberately.** The refusal reaches chat, so every
repository name under `NANOCLAW_PROJECT_ROOTS` is visible to anyone who can talk
to the agent. Names only, no paths and no contents. An install whose repository
*names* are sensitive should keep those checkouts out of the allowlist.

## 1.5 One level of delegation

A worker may not spawn a worker. Depth 2 is not slow, it is structurally
unanswerable: the inner 600 s wait starts first and expires first, every time,
so both agents report being blocked on a question that was being answered.
Neither can shorten its bound, because neither can see how deep the chain is.

Gated on the host via `origin_session_id`, because a container cannot be relied
on to gate itself.

---

# 2. `answer_worker`

## The problem

Every existing door into a worker writes the same row. `send_message` and
`spawn_worker`'s reuse path both call `routeAgentMessage`, producing an
identical `kind: 'chat'` envelope:

```
ORCHESTRATOR                    HOST                      worker's inbound
     ├─ send_message(to:"scout")─► routeAgentMessage ────► kind=chat
     │
     ├─ spawn_worker(repo,task) ─► existingWorkerFor → REUSED
                                   deliverBrief
                                     └─ routeAgentMessage ► kind=chat
                                                                ▲
                                        byte-identical — a blocked tool
                                        cannot tell an answer from new work
```

So the ambiguity is not about which tool the orchestrator picks. It is that no
door carries intent.

### Why `in_reply_to` cannot fix this

Two reasons, the second fatal:

1. `messages_in` has no `in_reply_to` column, and `performAgentRoute` mints a
   fresh `a2a-…` id rather than carrying the question's.
2. `in_reply_to` is **batch-scoped**. `poll-loop.ts` sets it once per batch, so
   every message the orchestrator writes that turn carries the same value —
   including a second, unrelated one. The exact case needing separation stays
   indistinguishable.

### Why a flag on `send_message` was rejected

`send_message({to, text, answer: true})` was considered and dropped.
`send_message` is already polymorphic over destination type — `to:"ai-anya"` is
a channel, `to:"scout"` is an agent. A flag would make one verb span *post to a
channel*, *give a worker work*, and *unblock a waiting call*, distinguished only
by an argument. In a transcript those three read identically. The flag is also
not a modifier: it switches the row kind and the host path, which makes it a
different tool wearing a costume.

### What Claude Code does, and why it cannot be copied

Its subagent lives inside one tool call, so the parent is blocked for the
child's whole life and **cannot send it anything**. The child's output is the
tool result; there is no message channel at all. `parent_tool_use_id` and
`forwardSubagentText` are for rendering a nested transcript, not for routing.

That property is why a Claude Code subagent asks the human directly — the parent
is inside the call and physically cannot answer. The two halves are one coin:

```
Claude Code:  parent blocked ──► no ambiguity ──► parent can't answer ──► child asks human
nanoclaw:     parent free    ──► parent answers ──► parent sends other things ──► ambiguity
```

A separate container with its own mailbox is the price of standing in another
repository with another `CLAUDE.md`. So the copyable lesson is the *constraint*,
not the mechanism: **the answer is a return value, not a message** — which in a
mailbox world means the answer gets its own row kind.

## 2.1 The question carries its own metadata

```
   USER            ORCHESTRATOR              WORKER              HOST
     │                   ├─ spawn_worker ─────►│                  │
     │                   │                     ├─ ask_user_question
     │                   │                     │  kind=chat:
     │                   │                     │  { text: <prose>,
     │                   │                     │    question:{id:"msg-abc"} }
     │                   │◄────────────────────┼──────────────────►│
     │                   │  renders `text`     │ ░   sees `question`
     │                   │                     │ ░   createPendingQuestion
     │                   │                     │ ░   expires at +600 s
     │                   │                     │ ░ BLOCKED
     │                   │                     │ ░ findQuestionResponse(msg-abc)
```

One envelope, two readers: prose for the orchestrator's formatter, structured
metadata for the host. This is the symmetric twin of the channel path's
`createPendingQuestion`, which the agent lane skips because of the
`channel_type === 'agent'` early return in `delivery.ts`.

The kind stays `chat`. Anything else and `performAgentRoute` renders an empty
message — the original bug.

## 2.2 Orchestrator knows the answer

```
   USER            ORCHESTRATOR              WORKER              HOST
     │                   │◄─ question ─────────┤ ░ BLOCKED        │
     │            ┌──────┴──────┐              │ ░                │
     │            │ knows it    │              │ ░                │
     │            └──────┬──────┘              │ ░                │
     │                   ├─ answer_worker({ ───┼──────────────────►│
     │                   │    worker:"scout",  │ ░   open question
     │                   │    answer:"Delete it"})  for scout? YES
     │                   │                     │ ░◄───────┘
     │                   │                     │ ░  kind=SYSTEM
     │                   │              ┌──────┴──────┐ question_response
     │                   │              │ tool returns│ questionId=msg-abc
     │                   │              └──────┬──────┘ same turn, full ctx
     │◄─ "done" ─────────┤◄────────────────────┤
```

The human is never involved. That hop is a filter, not a detour — most worker
questions are answerable by the agent that wrote the brief.

Three verbs, three meanings, nothing inferred:

| verb | means |
|---|---|
| `spawn_worker` | create-or-brief |
| `send_message` | talk — to a channel *or* an agent |
| `answer_worker` | unblock a waiting call |

## 2.3 Orchestrator must ask the human

```
   USER            ORCHESTRATOR              WORKER
     │                   │◄─ question ─────────┤ ░ BLOCKED 600 s
     │            ┌──────┴──────┐              │ ░
     │            │ doesn't know│              │ ░
     │            └──────┬──────┘              │ ░
     │◄─ ask_user_question                     │ ░ ▓ inner 300 s
     │   CARD, own thread │                    │ ░ ▓ CONTAINED by
     ├─ clicks "Delete it" ►│                  │ ░ ▓ the outer 600 s
     │                   │  question_response  │ ░
     │                   ├─ answer_worker ────►│ ░ kind=system
     │◄─ "done" ─────────┤◄─────────────┤ returns
```

Both waits become the **same function**, `findQuestionResponse`. The lane only
chose card-versus-prose on the way out.

## 2.4 More work arrives while blocked

```
   USER            ORCHESTRATOR              WORKER
     │                   │◄─ question ─────────┤ ░ BLOCKED
     │                   ├─ send_message ─────►│ ░ kind=chat
     │                   │  "also bump the dep"│ ░  pushed at the model
     │                   ├─ answer_worker ────►│ ░ kind=system  MATCH
     │                   │  "Delete it"        │ ░
     │                   │              ┌──────┴──────┐
     │                   │              │ tool returns│
     │                   │              └──────┬──────┘
```

Order stops mattering. Today the first chat row with text wins, so a second
instruction sent during the same turn is silently relabelled as the answer.

## 2.5 Nobody answers — expiry does the work

```
   USER            ORCHESTRATOR              WORKER              HOST
     │                   │◄─ question ─────────┤ ░ ...600 s...     │
     │                   │                     ├─ markLateAnswerExpected
     │                   │◄─ "blocked on X" ───┤   turn ENDS       │
     │                   │                     ╳          pending question
     │        · · · later · · ·                │          EXPIRED at +600 s
     │                   ├─ answer_worker ─────┼───────────────────►│
     │                   │                     │   no open question │
     │                   │                     │◄───────┘
     │                   │                     │  delivered as kind=CHAT
     │                   │              ┌──────┴──────┐
     │                   │              │ wakes, NEW  │ transcript KEPT
     │                   │              │ batch       │
```

**The expiry is load-bearing.** A `system` row is skipped by kind in the poll
loop, so a late answer with no tool waiting would be silently discarded. Bounding
the host's pending row by the same 600 s the tool waits makes a late
`answer_worker` degrade to an ordinary message instead — and the tool can say so
in its result.

`markLateAnswerExpected` keeps the transcript for exactly one batch, so the late
answer lands with its question still above it.

## 2.6 Channel sessions are untouched

```
   USER            ORCHESTRATOR
     ├─ "should I?" ────►│
     │◄─ ask_user_question│ ░ BLOCKED 300 s
     ├─ clicks ──────────►│ ░ question_response
     │◄─ "done" ──────────┤
```

## What section 2 deleted

It was a net deletion. Removed:

- `markAwaitingInbound` / `clearAwaitingInbound` / `isToolAwaitingInbound`
- the poll-loop hold that consumes them
- `findEscalatedAnswers`, its SQLite operation, its `MailboxOperations` method
  and its `db/messages-in.ts` wrapper
- the `askedAt` timestamp filter and the text-presence filter, with `messageText`

Added: one tool, the `question` field on the escalated envelope, and
`createPendingQuestion` on the agent lane.

---

# 3. Worker on a channel

Motivating case: `saber-pr-babysit`, which drives a review loop by talking to a
human reviewer in Slack. A worker running that workflow needs to post and to
hear the reply.

It used to be stopped at the first of three gates, and each one had to be
opened deliberately rather than removed:

| gate | where | what it says |
|---|---|---|
| 1 | container, `resolveRouting` | `Unknown destination "ai-anya"` |
| 2 | host, `delivery.ts` | `unauthorized channel destination: <worker> cannot send to slack/…` |
| 3 | router, `session-manager.ts` | `bound.agent_group_id === agentGroupId` |

`provision-agent.ts` still grants a worker exactly two destinations of its own,
both `target_type: 'agent'` — `<localName>` and `parent`. A channel row is only
ever added by an explicit `channels` argument on the spawn, copied from the
caller.

## The shape

A worker gains a **second correspondent**, and the two must not be collapsed:

| | orchestrator | ai-anya thread |
|---|---|---|
| role | the worker's **principal** | a **work counterparty** |
| how addressed | session routing (implicit) | `send_message({to:"ai-anya"})` (explicit) |
| receives `ask_user_question` | **yes** | no |
| receives the final report | **yes** | no |

## 3.1 The grant — attenuated delegation

```
   USER            ORCHESTRATOR                    HOST              WORKER
     ├─ "babysit PR" ───►│                          │                  │
     │                   ├─ spawn_worker({repo,task,│                  │
     │                   │    channels:["ai-anya"]})│                  │
     │                   │              ───────────►│                  │
     │                   │                          │ getDestinationByName(
     │                   │                          │   ORCHESTRATOR,"ai-anya")
     │                   │                          │   ┌────┴────┐
     │                   │                          │   │ holds it│ ✓ copy
     │                   │                          │   │ doesn't │ ✗ REFUSE
     │                   │                          │   └────┬────┘
     │                   │                          │ createDestination ──►│
```

**You cannot grant what you do not hold.** One lookup is the entire security
model, and it is the right one: the worker runs code from another repository, so
its own instructions must never widen its reach. The grant goes through the
existing guard seam so an install can require approval.

## 3.2 Worker opens the thread

```
   ai-anya          ORCHESTRATOR              WORKER
     │                    │                     ├─ send_message({to:"ai-anya"})
     │                    │                     │   no prior inbound → null
     │◄───────────────────┼─────────────────────┤   "PR #42 ready"
     │  TOP-LEVEL → thread T, root R            │
     │                    │              ┌──────┴──────┐
     │                    │              │ HOOK 1      │ unchanged — it was
     │                    │              │ bind(mg, R) │ writing a DEAD
     │                    │              └──────┬──────┘ binding, now live
```

## 3.3 Anya replies — the router change

```
   ai-anya          ORCHESTRATOR              WORKER
     ├─ Anya replies in T │                     │
     │   ROUTER fan-out:  │                     │
     │  ① wired agents (messaging_group_agents) │
     │        ├─ ORCHESTRATOR engage=mention    │
     │        │  not tagged → does NOT engage   │
     │  ② NEW: bound sessions ──────────────────┼──► findSessionBoundToThread
     │        │           │                     │      (ai-anya, R)
     │        │           │                     │    NOT wired — the
     │        │           │                     │    BINDING is the grant
     │        └───────────┼────────────────────►│  same session, full ctx
     │                    │              ┌──────┴──────┐
     │                    │              │ channel_type│ visibly Anya,
     │                    │              │  = 'slack'  │ not the orchestrator
```

**Additive, not a replacement.** Wired agents resolve exactly as they do today
and the bound session is delivered to *in addition*, so no existing group can
regress.

**Thread-scoped, not channel-scoped.** The worker receives replies in its own
thread and nothing else in ai-anya. No `messaging_group_agents` row, so no
persistent wiring to clean up — the grant dies with the session.

**The binding is the engagement signal.** A bound session has no `engage_mode`;
the worker opened that thread for this purpose, so a reply in it always engages.
Same reasoning as `mention-sticky`.

Hook 2's agent-group gate stays as it is. It protects the *wired* path, where a
binding must never hand one agent another's session. On this new path the
binding *names* the agent group, so it is authoritative rather than a filter.

## 3.4 The worker replies IN the thread

```
   ai-anya          ORCHESTRATOR              WORKER
     │  (Anya's reply is now the latest inbound from slack/ai-anya)
     │                    │                     ├─ send_message({to:"ai-anya"})
     │                    │                     │   resolveRouting:
     │                    │                     │   my own channel? NO
     │                    │                     │   have any channel? NO
     │                    │                     │   └─► getLatestInboundRoute
     │                    │                     │        → thread T   ← NEW
     │◄───────────────────┼─────────────────────┤
     │  posts INSIDE T ✓  │                     │
```

**Without this the conversation fragments.** `resolveRouting` in
`mcp-tools/core.ts` preserves a thread only when the destination *is* the
session's own channel. A worker's session routing is `channel_type='agent'`, so
that comparison always fails and every reply posts top-level — a new thread each
time, and hook 1 is first-wins so the orphans never bind.

The `<message to="...">` XML path does not have this bug: `sendToDestination`
already uses `getLatestInboundRoute`. Two doors, one of them wrong.

The fallback is scoped to sessions with **no channel of their own**, so an
ordinary chat session keeps today's behaviour exactly and the removed hook 3
cannot return through this door.

## 3.5 Decisions still go to the orchestrator

```
   ai-anya          ORCHESTRATOR              WORKER
     ├─ Anya: "rework the migration" ──────────►│
     │                    │              ┌──────┴──────┐
     │                    │              │ should I?   │
     │                    │              └──────┬──────┘
     │                    │◄─ ask_user_question │ ░ to the ORCHESTRATOR
     │                    ├─ answer_worker ────►│ ░
     │◄───────────────────┼─────────────────────┤ send_message({to:"ai-anya"})
```

`writeSessionRouting` is **untouched**, and that is a decision rather than an
omission. Anya is a review counterparty; the orchestrator is the worker's
principal. A worker asking *"should I rework this?"* is asking the agent that
briefed it, not the reviewer who raised it.

**The escalation trigger is whose decision it is, not whether a human is
reachable.**

## Limits

- **One thread per worker session.** The binding is first-wins with no clearer.
  For pr-babysit that is right — one PR, one thread. A second concurrent review
  needs a second worker, which a second orchestrator thread already gives you.
- **The worker cannot post outside its grant.** Gate 2 still refuses.
- **Anya's messages elsewhere in ai-anya never reach the worker.**
- **The channel must have at least one agent wired to it.** `routeInbound`
  returns early when the messaging group has no wired agents at all, before the
  bound-session pass runs — so lending a worker a channel nobody else is wired
  to silently does not work. Harmless for pr-babysit, where the orchestrator is
  wired to ai-anya. Fixing it means moving the bound lookup above that early
  return, which tangles with the channel-registration escalation that lives
  there; it was left alone deliberately.

## Two details the design did not anticipate

**The grant belongs on the precheck's reuse path, not the body's.** A reused
worker is answered inside `validateSpawnWorker`, which responds `reused` and
returns `false` — so the guard-allow body never runs. The reuse branch in
`spawnWorker` only catches a worker created concurrently between the two
lookups. Granting only there compiles, passes a create-path test, and silently
lends nothing on the path that actually fires.

**A running worker needs the map re-projected.** `spawnContainer` writes the
destination map on every wake, so a worker created with a grant reads it at
startup. One that is ALREADY RUNNING holds the map from its last wake, and its
container answers "unknown destination" for a channel the central DB says it
holds. The grant therefore re-projects into every live session of the worker.

---

# Traps, for whoever changes this next

- **`delivery.ts`'s `channel_type === 'agent'` early return** is where the
  original bug lived and where `recordEscalatedQuestion` now sits. It returns
  before the channel send, the thread binding, and `createPendingQuestion`.
- **`performAgentRoute` renders `content.text` only.** Any structured field must
  ride alongside prose, never instead of it — that is why the escalated
  envelope carries both.
- **The question TTL is duplicated on purpose, in two places that must agree.**
  `ESCALATED_TIMEOUT_S` in the container's `interactive.ts` and
  `QUESTION_TTL_MS` in `answer-worker.ts`. Past the tool's bound nothing is
  polling, so a `question_response` written then is skipped by kind and lost;
  bounding the host on the same clock is what turns that loss into a plain
  message. Move them together.
- **The bound-session pass is delivery-only and additive.** It counts toward
  `engagedCount` so a delivered message is not audited as dropped, and it skips
  any agent group the wired loop already served. It deliberately does not run
  `backfillNewSession` (the session is long alive) or `fanInboundMessage` (a
  bound worker is a guest in the thread, not a member of the chat's session
  family). It DOES run the command gate, so a bound thread is not the one
  inbound door where an admin command arrives unclassified.
- **`resolveRouting`'s fallback is scoped to a session with no channel of its
  own.** Widening it would resurrect the removed outbound redirect described in
  §1.2 — a `shared`-mode session's `thread_id` is always null and the binding is
  first-wins, so the first thread it ever opened would capture everything after.
- **`bun:sqlite` needs `$name` in both SQL and JS keys.** It does not strip the
  prefix the way `better-sqlite3` does on the host.
- **Container tests import from `bun:test`**, and `vitest.config.ts` excludes
  that tree. Run them from `container/agent-runner`.
- **Neither section needed a migration.** The question TTL is derived from
  `created_at`; destinations and thread bindings already existed.
