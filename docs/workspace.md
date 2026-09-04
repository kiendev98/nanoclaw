# The workspace root

One variable places every host-owned tree. Set `NANOCLAW_WORKSPACE_DIR` in
`.env`, or leave it unset for the default `~/.saber`.

| Tree | Path | Holds |
|---|---|---|
| groups | `$NANOCLAW_WORKSPACE_DIR/groups` | per-group memory, the composed project document, telemetry |
| data | `$NANOCLAW_WORKSPACE_DIR/data` | the central DB, session mailboxes, driver session records |
| store | `$NANOCLAW_WORKSPACE_DIR/store` | channel adapter state |

## Why the root must sit outside every repository

Claude Code builds project memory by walking UP from the agent's working
directory. It merges every `CLAUDE.md` it passes, and the walk does not stop at
a repository root.

Upstream derives these trees from `process.cwd()`, which under launchd is the
checkout. An agent standing in `<checkout>/groups/<folder>` therefore loads the
checkout's own maintainer guidance on every turn. One measured session paid
21,100 tokens for a document about maintaining the tool the agent was running
on.

So the property that matters is not the path. It is that no ancestor of the
root holds a `CLAUDE.md`. Point the variable anywhere that keeps that true.
Pointing it inside a repository re-creates the leak.

## Why one variable and not one per tree

These trees differ only in name. All are host-owned, and all belong outside
every repository. A new one costs a `path.join`, not a new key.

## Moving an existing install

State used to live in the checkout. The host refuses to start when the checkout
holds a database and the workspace does not, because starting would create an
empty one and report healthy. Move the trees:

```bash
mkdir -p ~/.saber
mv <checkout>/data ~/.saber/data
mv <checkout>/groups ~/.saber/groups
mv <checkout>/store ~/.saber/store
```

To keep the old layout instead, set `NANOCLAW_WORKSPACE_DIR=<checkout>`.

## Not the runner roots

`container/agent-runner/src/roots.ts` names six more paths, and none of them is
configuration. A driver assigns them per spawn from the session's mount list,
mapping a container path to an unrelated host path. They cannot collapse into
one prefix, and that module explains why.

The one an operator might confuse with this variable is `NANOCLAW_SESSION_DIR`,
which addresses a single session's mailbox. It is set by the driver. Setting it
by hand does nothing useful.
