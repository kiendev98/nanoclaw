## Delegating work in another repository (`create_worker`)

`mcp__nanoclaw__create_worker({ repo, task })` puts a WORKER inside a git worktree of that repository. It is a separate agent with its own process and its own working directory, so it loads that repository's `CLAUDE.md`, skills and settings. You stay where you are and hold the conversation.

One call does everything: the worker is created (or the existing one is reused) and `task` is delivered to it as its brief. Do not follow the call with a message. The call returns when the worker exists and has been briefed — its ANSWER arrives later, as a message that wakes you.

The choice between this and the SDK `Task` tool is in the tool's own description: same repository → `Task`; different repository → `create_worker`. Read it there.

### Rules

- **Never delegate a session-state command.** `/compact`, `/context`, `/cost` and `/clear` act on the session they are typed in. Run them here, in this session, always. Sending `/compact` to a worker compacts an empty session and leaves yours untouched.
- **Delegate repository work only when the user names the repository.** Do not infer one from the topic, from the last repository you worked in, or from a file path. If no repository is named, ask which one.
- **Write a `task` that stands alone.** The worker starts with an empty context and cannot read this thread. Expand every reference — "this feature", "the bug above", "as discussed" — into explicit text: what to change, in which files, and what the result must be. A `task` may instead be a slash command such as `/blueprint FMTA-343`, which runs as a real command in the worker's session; but the task is its whole context, so a command that does not carry its own subject needs the brief after it.
- **One worker per repository per conversation.** Asking again for the same repository in this thread returns the FIRST worker and delivers the new task to it, because a second would stand on a second branch and could not see the work already done.
- **Post every worker reply into this conversation.** You are the only path to the human — nothing else delivers it, and the user sees nothing until you speak. Quote the worker's own output verbatim instead of summarising it, and name the worker and its repository. Add your decision or the next step after the quote, never in place of it.
- **Relay a worker's question, then send the answer back to that same worker.** Put the question to the human yourself and deliver their reply to the worker that asked. Never answer on the human's behalf, and never create a second worker to carry the answer.

### If you are the worker

- **Your replies reach your orchestrator automatically.** Everything you write goes to it — you never have to address it. Use `send_message` only to reach some OTHER destination.
- **Ask by messaging your orchestrator — never with `ask_user_question`.** That card is written to your OWN routing, which for a worker is the agent-to-agent lane, so no person ever sees it, and the call then blocks on a poll that a worker → orchestrator → human → worker round trip outruns. A message costs nothing: your turn ends, and the reply resumes this same session with your full transcript.
