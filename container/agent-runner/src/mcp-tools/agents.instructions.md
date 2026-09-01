## Companion and collaborator agents (`create_agent`)

`mcp__nanoclaw__create_agent({ name, instructions, repo })` spins up a new long-lived agent and wires it as a destination — bidirectional, so you can send it tasks and it can message you back. `repo` is optional; it puts the new agent inside a git worktree of that repository (see "Delegating work in a repository" below).

### How it works

- Creates a new agent with its own container, workspace, and session. Your `instructions` string becomes its `instructions.prepend.md` — its standing role and personality.
- The agent's `name` becomes a destination on both sides: you address it via `send_message({ to: "<name>", ... })`, and its replies arrive as inbound messages with `from="<name>"`.
- Each agent has its own persistent workspace under `groups/<folder>/` — memory, conversation history, and notes all survive across sessions. This is a full standalone agent, not a stateless sub-query.
- **Fire-and-forget:** the call returns immediately without waiting for the agent to confirm it's ready. Messages you send will queue until it's up.

### When to use

- **Companions** — a long-running presence that accumulates context over time: a `Researcher` tracking an ongoing inquiry, a `Calendar` agent managing scheduling, an assistant that knows your preferences and history.
- **Collaborators** — a parallel specialist that works independently and reports back: a `Builder` handling code edits while you stay in conversation, a `Reviewer` running checks in the background.

The right frame is: does this agent need its own memory and context that builds over time, or does it need to work independently without blocking your turn? Either is a good reason to spawn one.

### When NOT to use

- **One-off lookups or short tasks** — use the SDK `Agent` tool instead. It's stateless, spins up and completes in one shot, and leaves no persistent footprint.
- **Work that finishes before the user's next message** — agents persist indefinitely. Don't create one for something you could do inline.

### Delegating work in a repository

Give an agent a `repo` and it works inside a git worktree of that repository, with that repository's `CLAUDE.md`, skills and settings loaded. You stay where you are and hold the conversation. Three rules:

- **Never delegate a session-state command.** `/compact`, `/context`, `/cost` and `/clear` act on the session they are typed in. Run them here, in this session, always. Sending `/compact` to a worker compacts an empty session and leaves yours untouched.
- **Delegate repository work only when the user names the repository.** Do not infer one from the topic, from the last repository you worked in, or from a file path. If no repository is named, ask which one.
- **Write a brief that stands alone.** The worker starts with an empty context and cannot read this thread. Expand every reference — "this feature", "the bug above", "as discussed" — into explicit text: what to change, in which files, and what the result must be.

### Writing good `instructions`

Cover: the agent's role, who it takes tasks from (you, by name), how it should report back (on completion only? with milestones for long work?), and any domain-specific rules. Don't restate NanoClaw base behavior — the shared base is already loaded on the agent's end.
