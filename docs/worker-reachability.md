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
the host's pending row on the tool's own deadline makes a late `answer_worker`
degrade to an ordinary message instead — and the tool can say so in its result.

**The deadline travels; it is not a second copy of the constant.** This was two
600 s constants, one per runtime, held together by a comment asking them to move
together. A comment cannot hold that, and two separate things broke it:
`ask_user_question` takes a caller-supplied `timeout`, so the pair could diverge
per call with nothing wrong in either file; and even at equal values the clocks
start at different moments, because the host stamps `created_at` when DELIVERY
processes the outbound row, a poll after the tool began waiting. Both gaps end
identically — the fast path writes a `question_response` for a tool that has
stopped listening, and it is dropped by kind.

So the tool sends its own `expiresAt` in the envelope that already carries
`title` and `options`, and the host stores it (`expires_at`, migration 029). It
is computed BEFORE the write, so the stored instant is slightly earlier than the
one the tool truly waits until — the safe direction, because expiring early
delivers the answer as prose while the tool still listens, and expiring late
destroys it. A row written by an older container carries no deadline and falls
back to the historical bound.

**There is no longer a flag holding the transcript open, because nothing
closes it.** A worker used to start every task with a clean transcript
(`freshSessionPerTask`), so a late answer would have landed with no question
above it — the exact failure this section exists to prevent. Two mechanisms
guarded that one case: `markLateAnswerExpected`, which named the question the
worker was still waiting on, and an `answersQuestionId` tag the host attached to
a degraded answer so only the message CARRYING that answer cleared the flag.

Both are gone, along with the wipe. A worker resumes like every other session,
so the question is always still above the answer — unconditionally, rather than
by exception. What bounds a resuming worker's context is autocompact, which is
lossier than a wipe in a different way: older turns become a summary rather than
nothing at all, which is strictly more than the wipe preserved.

The `NOTES.md` handoff went with the wipe. It was injected into every worker's
standing document to carry the one thing a wipe destroyed and the worktree did
not hold — what was tried, rejected, and why. With the transcript kept, it asked
each task to maintain a second copy, by hand, of what the conversation already
says.

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
- **A denied channel stays denied.** `denied_at` is a person saying this
  channel may not be used, and a session that opened a thread there before the
  refusal is not a way back in. The binding does not outrank the human.

## The channel needs no wiring of its own

`routeInbound` short-circuits on `agentCount === 0` about 160 lines before the
bound-session pass, and `agentCount` counts `messaging_group_agents` rows — of
which a binding writes none. That absence is deliberate: it is what makes a
lent channel die with the session instead of leaving a wiring row for an
operator to find later. But it also meant the count could not see the one
consumer that existed, so a worker lent a channel no other agent used had every
reply dropped, while the post it was replying to went out perfectly well.
Outbound worked and inbound did not, which is the hardest shape to diagnose.

The lookup now runs inside that branch, before it decides the channel is
uninteresting. Three things keep it honest:

- **The cheap short-circuit survives.** The binding lookup is one indexed read
  and almost always misses; the sender is resolved only once it hits. An
  ordinary unwired channel still costs what it did — no auto-create, no sender
  resolution, no log spam.
- **A delivery ends the branch.** It returns instead of recording
  `no_agent_wired` and escalating for channel registration, so an operator is
  never asked to wire a channel that already has its consumer.
- **`denied_at` is checked in the lookup itself**, not at the call sites, so
  the next caller added cannot forget it.

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

# 4. One door per intent

Sections 1 to 3 gave a worker three ways to be heard. A live run used a fourth
that nobody designed, and this section closes it — and opens the one that was
missing.

## What happened

`saber-pr-babysit`, dispatched to a `wego-ai` worker. In twenty-three minutes
it sent its orchestrator **three** reports, each by calling
`send_message({to:"parent"})`. §1.1 says a worker reports once, at stream
close, and the runner writes it. None of these went that way.

```
13:14:50  send_message({to:"parent", message:"On it — …"})   ✗ err: text is required
13:18:32  send_message({to:"parent", text:"Status on #1845…"})  → relayed to Slack
13:22:35  send_message({to:"parent", text:"Still on #1845…"})   → relayed to Slack
13:34:04  (529 Overloaded — the lane delivered this one)
```

Nothing failed. The orchestrator relayed two of them to a human, correctly
labelled. But the "one report per worker" property was gone, and it was gone by
a route the design never considered.

## Why the door was open

The `parent` destination is a **permission that was also an address**.

`provision-agent.ts` grants every worker a row naming its orchestrator, and the
comment there says exactly why: the runner's automatic report is routed by
code, and that route passes `a2a.send`, *"which denies any pair with no
destination row. Without this row a worker's answer is denied and dropped."*

The row had to exist. The NAME did not — it is a side effect of upstream's
model, where `e83ffbc1` ("named destinations + permission enforcement") made
one table serve both jobs at once. Grant the permission, publish the name.

So this is a seam, not a bug in either half:

| | assumes |
|---|---|
| upstream's named destinations | reaching a correspondent means naming it |
| §1.1's worker lane | reaching your orchestrator is done BY CODE |

A worker sits under both. `send_message` behaved exactly as designed; a worker
just is not the correspondent that design had in mind.

## Why prose did not hold it

Two documents already said not to do this, and the model read a third that said
to:

- `workers.instructions.md` — *"Use `send_message` only to reach some OTHER
  destination."*
- §3's table — the orchestrator is addressed by "session routing (implicit)".
- `destinations.ts` — *"The `send_message` MCP tool is the same delivery,
  available mid-turn — handy for a quick acknowledgment ('on it') before a slow
  tool call."*

The third is sound advice for a **channel** session, where a human is watching
and a slow turn reads as silence. It is emitted for every session with
`mode.kind === 'chat'`, and a worker's inbound messages are `kind: 'chat'`. So
the worker got advice written for an audience it does not have, and followed
it.

**A rule stated in three places and enforced in none is a suggestion.**

## The missing door

Closing `to:"parent"` on its own would have been half a fix, because the model
was reaching for something real. A worker had exactly two ways to speak:

| | when | cost |
|---|---|---|
| the lane report | stream close only | cannot be used mid-task |
| `ask_user_question` | any time | **blocks 600 s** |

Neither is "tell it something and keep working". The nearest tool with that
shape was the one it was not supposed to use — so it used it. Withdrawing the
name without adding the missing tool would leave the same pressure against a
closed door, and the next worker would find some other way through.

## What ships

**`send_message` refuses a destination that resolves to the caller's own
orchestrator, and the refusal names both replacements.**

Scoped on `isAgentLane(getSessionRouting())`, and that scope is the whole
correctness argument. `workerOrchestratorGroup` returns null unless BOTH
`workspace_path` and `origin_session_id` are set, and **`create_agent` leaves
both NULL** — so a companion agent never routes as `channel_type: 'agent'`,
never gets a lane, and never gets an automatic report. For a companion,
`parent` is its ONLY way to reach its creator. A refusal keyed on "is an agent
destination" rather than on the lane would have cut every companion off from
the agent that made it.

It matches on the TARGET, not on the name. `provision-agent.ts` mints
`parent-2`, `parent-3`… on collision, so a name check would miss exactly the
groups that already had one.

**`report_progress({text})` is the door that opens.** It writes to the lane
immediately, returns at once, does not end the turn, and does not block. Three
properties are load-bearing:

- **It is marked.** The text carries `[progress — not the final answer, no need
  to relay]`. §1.1's whole value is that the orchestrator can tell the answer
  from a draft; an unmarked mid-turn message destroys that, which is what
  happened above. The marker also tells the orchestrator not to relay it, so a
  human still sees one report per worker.
- **The marker rides in the TEXT, not as a JSON field.** The orchestrator reads
  this through the ordinary formatter, and `<message from=…>` renders
  `content.text` and drops everything else — a field would be invisible at
  exactly the moment it must be read. (This is the same failure §1.3 records
  for the escalated question card, which arrived as an empty message for the
  same reason.)
- **It does not supersede.** Two notes are two messages. Superseding is right
  for the report, where only the outcome matters; a progress note that is
  overwritten by the next one is not a progress note.

**The contradicting guidance is scoped.** `buildDestinationsSection` now
branches on the lane and gives a worker its own three paragraphs — write your
answer, only the last turn is delivered, `report_progress` to speak early — and
returns before the mid-turn-acknowledgment advice that is written for a human
audience.

## The shape, after

```
   ai-anya          ORCHESTRATOR                      WORKER
     │                    │                              │
     │                    │◄──── runner lane flush ──────┤  the ANSWER, once, at close
     │                    │◄──── report_progress ────────┤  early note, marked, non-blocking
     │                    │◄──── ask_user_question ──────┤  BLOCKS 600s, answer is the return value
     │                    ├───── answer_worker ─────────►│  kind=system, unblocks
     │                    ├───── send_message ──────────►│  kind=chat, new work
     │                    ├───── spawn_worker ──────────►│  kind=chat, provision + brief
     │◄───────────────────┼───── send_message ───────────┤  counterparty, kind=slack
```

Every worker→orchestrator arrow is now a different tool with a different
guarantee, and `send_message` no longer appears among them.

## What was considered and not done

**Merging `answer_worker` into `send_message`.** Rejected in §2 and re-raised
here. The two callers of `routeAgentMessage` already write a byte-identical
`kind: 'chat'` row; a third would not add intent, it would remove the one row
kind that carries it, and §2.4's silent mis-answer returns as the normal case.

**Renaming `answer_worker` to `send_worker_message`.** The name would promise
general messaging while the tool answers questions, inviting the same class of
mistake this section fixes — a name that suggests a use the design does not
intend.

**Removing the automatic report so the worker decides everything.** It is a
real trade and it was declined for one reason: `321cce4b` flushes from
`finally` *"so an errored run still reports how far it got"*. The 529 above
reached the orchestrator only through that lane. A discretionary report is not
sent by a worker that has crashed.

**A blanket refusal of agent destinations.** Would have broken every
`create_agent` companion, as above.

## Still open

- **`report_progress` is unproven under load.** The refusal is what today's run
  demanded; whether a worker reaches for the new tool at the right moment, or
  narrates with it, is a question only real traffic answers. The description
  says "sparingly" and names the three cases; that is a prompt, not a limit.
- **An orchestrator that fails to relay is still silent.** The same run's 529
  reached the orchestrator and stopped there — no relay, no timeout, no notice.
  §1.1 guarantees the report reaches the orchestrator and `workers.instructions.md`
  calls it *"the only path to the human"*, but nothing observes whether it
  actually spoke. That gap is untouched here.
- **The `parent` row is still a permission wearing an address.** This section
  withdraws the name at the one place it did harm. The general problem —
  upstream's table serving both jobs — is unchanged, and the next feature that
  needs a permission without a name will meet it again.

---

# Traps, for whoever changes this next

- **`delivery.ts`'s `channel_type === 'agent'` early return** is where the
  original bug lived and where `recordEscalatedQuestion` now sits. It returns
  before the channel send, the thread binding, and `createPendingQuestion`.
- **`performAgentRoute` renders `content.text` only.** Any structured field must
  ride alongside prose, never instead of it — that is why the escalated
  envelope carries both.
- **The question deadline is sent, not duplicated.** It was two constants that
  had to agree — `ESCALATED_TIMEOUT_S` and `QUESTION_TTL_MS` — and a caller-set
  `timeout` plus a delivery-poll of clock skew both broke the agreement without
  making either file wrong. The container now sends `expiresAt` and the host
  stores it. `LEGACY_QUESTION_TTL_MS` remains only for rows written before that.
- **The bound-session pass is delivery-only, and additive at AGENT-GROUP
  granularity.** It counts toward `engagedCount` so a delivered message is not
  audited as dropped, and it skips every agent group this chat's wiring names —
  not merely the ones the loop delivered to. That distinction is the whole
  property: the bind hook claims any session whose root post lands, wired or
  not, so an ordinary `mention` agent gets bound the first time it answers at
  top level, and a pass that re-decided engagement for it would silently turn
  `mention` into `mention-sticky` and hand a `sender_scope`-refused sender the
  reach two gates had just denied. Taking the skip set from the WIRING rather
  than from the loop's outcomes is what makes "additive" true rather than
  aspirational. It deliberately does not run
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
- **The orchestrator refusal is scoped on the LANE, never on "is an agent
  destination".** `create_agent` leaves `workspace_path` and
  `origin_session_id` NULL, so a companion has no lane, no automatic report,
  and `parent` as its only door. Widening the check to every agent destination
  cuts every companion off from the agent that made it — silently, since a
  refused `send_message` just returns an error the companion cannot act on.
- **It matches the TARGET, not the name `parent`.** `provision-agent.ts` mints
  `parent-2`, `parent-3`… on collision, so a name check misses exactly the
  groups that already had one.
- **`report_progress`'s marker lives in the message TEXT.** The orchestrator
  reads it through the ordinary formatter, which renders `content.text` and
  drops every other field — the same mechanism that made §1.3's question card
  arrive as an empty message. A field on the content JSON is invisible at the
  moment it has to be read.
- **Do not make `report_progress` supersede.** Superseding is right for the
  answer, where only the outcome matters. A progress note overwritten by the
  next one is not a progress note.
- **Guidance emitted for `mode.kind === 'chat'` reaches workers too**, because a
  worker's inbound messages are `kind: 'chat'`. That is how the
  mid-turn-acknowledgment advice in `destinations.ts` — sound for a human
  audience — reached a session whose correspondent is an agent. Anything added
  there needs the lane branch, or it is advice to two audiences at once.
