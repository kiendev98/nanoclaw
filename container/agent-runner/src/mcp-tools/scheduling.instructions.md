## Task scheduling (`ncl tasks`)

Use `ncl tasks` for one-shot and recurring tasks. Each task runs in its own isolated session. Its runtime prompt supplies the task-only delivery and run-log contract.

Pass `--name "<short label>"` on create to get a readable task id (e.g. `--name "sales briefing"` → `sales-briefing-a25c`); without it ids are `t-<hex>`.

Common commands:

```bash
ncl tasks create --name "ping" --prompt "Remind the user to call Dana" --process-after "tomorrow 18:00"
ncl tasks list
ncl tasks get ping-a25c        # includes run count, failures, and recent run-log lines
ncl tasks run ping-a25c         # fire once now without changing the schedule (testing)
ncl tasks update ping-a25c --prompt "New instructions"
ncl tasks pause ping-a25c
ncl tasks resume ping-a25c
ncl tasks cancel ping-a25c      # or --all as a kill switch
ncl tasks delete ping-a25c
```

Use good judgement on whether it's appropriate to check in with the user about the task prompt before task creation, and if so, whether to share verbatim or a description of it.

`--process-after` accepts UTC timestamps or naive local timestamps interpreted in the instance timezone (shown in the `<context timezone="..."/>` header).

Run `ncl tasks create --help` for schedules, options, and pre-task gate scripts (checks that run before you wake).

## Tasks in another repository

Pass `--repo <name>` on create. The series gets its own git worktree on branch `nanoclaw/<series-id>`, and every run of it starts there, so the run loads that repository's `CLAUDE.md`, skills and settings. The name comes from the operator allowlist and is never a path; an unknown name is refused.

The branch belongs to the series, not to a run, so all runs of one series share a worktree and its uncommitted work.

## `run_task` — hand work to a separate session

One call. It creates or reuses the workspace and queues the instruction; there is no `ncl tasks create` step first.

```
run_task({ instruction: "..." })                                own workspace, fire and forget
run_task({ repo: "saber", instruction: "..." })                 in a repository
run_task({ repo: "saber", instruction: "...", notify: true })   the result wakes you
```

`repo` is optional, and it decides what the run gets:

| | Where it runs | Use it for |
|---|---|---|
| with `repo` | a git worktree of that repository, loading its CLAUDE.md and skills | work in a **different** repository |
| without `repo` | your own workspace, cwd unchanged | long work that must not hold up this turn |

Either way it is a **separate session** — its own container and transcript, running alongside this conversation.

For work in your own repository that you need answered **in this turn**, use `Task` instead: it shares your working directory and costs nothing. `Task` cannot change directory, so pointing it at another repository reads your files while reporting on that one — and the answer looks correct.

The workspace is the pair (repository, this conversation), so calling twice the same way reuses the same worktree and branch, and the second run sees the first run's work. That is why there is no workspace argument to pass.

`instruction` is the run's entire context. It cannot read this conversation, so expand every reference — what to do, in which files, and what the result must be.

There is no blocking mode. A run is a whole agent turn, so `notify` is the way to get the result; end your turn after the call.
