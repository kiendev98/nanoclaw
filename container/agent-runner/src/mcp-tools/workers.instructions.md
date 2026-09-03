## Delegating work in another repository (`spawn_worker`, `answer_worker`)

`mcp__nanoclaw__spawn_worker({ repo, task })` puts a WORKER inside a git worktree of that repository. It is a separate agent with its own process and its own working directory, so it loads that repository's `CLAUDE.md`, skills and settings. You stay where you are and hold the conversation.

One call does everything: the worker is created (or the existing one is reused) and `task` is delivered to it as its brief. Do not follow the call with a message. The call returns when the worker exists and has been briefed — its ANSWER arrives later, as a message that wakes you.

The choice between this and the SDK `Task` tool is in the tool's own description: same repository → `Task`; different repository → `spawn_worker`. Read it there.

### Rules

- **Never delegate a session-state command.** `/compact`, `/context`, `/cost` and `/clear` act on the session they are typed in. Run them here, in this session, always. Sending `/compact` to a worker compacts an empty session and leaves yours untouched.
- **Delegate repository work only when the user names the repository.** Do not infer one from the topic, from the last repository you worked in, or from a file path. If no repository is named, ask which one.
- **Write a `task` that stands alone.** The worker starts with an empty context and cannot read this thread. Expand every reference — "this feature", "the bug above", "as discussed" — into explicit text: what to change, in which files, and what the result must be. A `task` may instead be a slash command such as `/blueprint FMTA-343`, which runs as a real command in the worker's session; but the task is its whole context, so a command that does not carry its own subject needs the brief after it.
- **One worker per repository per conversation.** Asking again for the same repository in this thread returns the FIRST worker and delivers the new task to it, because a second would stand on a second branch and could not see the work already done.
- **Post every worker reply into this conversation.** You are the only path to the human — nothing else delivers it, and the user sees nothing until you speak. Quote the worker's own output verbatim instead of summarising it, and name the worker and its repository. Add your decision or the next step after the quote, never in place of it.
- **Answer a worker's question with `answer_worker`, never with a message.** A worker that asks you something is BLOCKED inside the call, and `answer_worker({ worker, answer })` is the only thing that unblocks it. An ordinary message arrives beside the question as new work, so the worker keeps waiting and then times out. Answer from what you know when you can; when the decision is the human's, put it to them yourself and relay their reply. Never create a second worker to carry an answer.

### If you are the worker

- **Your replies reach your orchestrator automatically.** Everything you write goes to it — you never have to address it. Use `send_message` only to reach some OTHER destination.
- **Ask with `ask_user_question`, and it reaches your orchestrator.** You have no channel of your own, so the tool sends the question down your only address as readable prose rather than as a card no one could see. It blocks for ten minutes, which is long enough for your orchestrator to put the question to a human and relay the answer back. The answer becomes the call's return value, so you carry on mid-thought with your full context.
- **If it times out, say what you are blocked on and end your turn.** Do not ask again — a second question waits behind the same silence. A late answer reaches you as a new message, with your transcript kept, so the question is still above it.
