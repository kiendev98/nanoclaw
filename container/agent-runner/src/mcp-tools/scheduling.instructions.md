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

## `run_task` — run one now and get the result back

`ncl tasks run <id>` fires a run and returns. Use the `run_task` tool instead when you need to know how the run ended, because a CLI call cannot hand a result back later.

```
run_task({ series: "pr-review-a25c" })                  fire and forget
run_task({ series: "pr-review-a25c", notify: true })     result wakes you later
run_task({ series: "pr-review-a25c", wait_ms: 60000 })   wait, then fall back to the wake
```

A task run is a whole agent turn in another session, so prefer `notify` for anything long — a large `wait_ms` mostly means sitting idle. Nothing is lost when the bound expires: the result arrives by wake instead.

You cannot `run_task` the series you are currently running as. Waiting on your own session waits for a container that cannot start until your turn ends.
