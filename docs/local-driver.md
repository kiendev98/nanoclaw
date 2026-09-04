# Local driver

The local driver runs the agent as a host process. The Docker driver runs it in
a container. Set `NANOCLAW_RUNTIME_DRIVER=docker` to select Docker again.

## What it trades away

Read this before you choose it.

Docker's container is the permission boundary. Under Docker the blast radius is
one container with an enumerated set of mounts. Under this driver the blast
radius is the user account the host runs as.

So this driver provides no isolation. It does not sandbox the filesystem. It
does not confine the network. It cannot enforce a read-only mount, because a
symlink has no mode of its own. The spec's `ro` states intent, not a guarantee.
`capabilities()` reports every one of those reductions honestly.

The provider runs with `permissionMode: 'auto'`, not `bypassPermissions`. Auto
denies a dangerous call and states a reason. It does not prompt, so it needs no
approval UI. That constraint made bypass look inevitable when chat is the only
surface. Auto is a gate. It is not a boundary, and it does not make this driver
an isolated one.

## Why it exists

Three things work only on the host. Together they are the whole reason.

**Credentials.** Claude Code on macOS keeps its token in the Keychain. The key
is a hash of `CLAUDE_CONFIG_DIR`. A Linux container has no Keychain, so the
Docker path needs a separately minted `CLAUDE_CODE_OAUTH_TOKEN` written to disk.
On the host the SDK spawns the local `claude`, which authenticates itself. No
token is minted, and none is stored.

**The account pool.** Auth belongs to the local `claude`. Whatever account is
active is the account the agent uses. An external switcher that rotates accounts
against rate limits therefore covers the agent too, at no cost. This driver does
not pin `CLAUDE_CONFIG_DIR`. It inherits the variable, which keeps the pool
shared rather than partitioned.

**The network.** A host process is on the host's VPN. Docker Desktop's VM has
its own network stack. That stack does not inherit routes from a utun interface.
Anything reachable only over the VPN is unreachable from a container, unless you
configure the VPN a second time inside it.

## How the container filesystem shape is realized

It is not realized. The runner names each of its roots and reads one environment
variable per root. This driver hands the runner real host directories. It plants
no symlink tree.

That matters because two container mounts overlap. `/workspace` is the session
directory. `/workspace/agent` is the group directory, nested inside that path. A
symlink at the parent would swallow writes meant for the child.

`/workspace/extra` is the one exception. Its entries are genuine leaves, so a
directory of symlinks is both correct and cheap.

`HOME` is inherited, and that is the point. `~/.claude` is the user's real
harness, so commands, agents, skills and rules load with no wiring.

## Environment the agent must not inherit

Two lists are scrubbed from every spawn.

`AUTH_OVERRIDE_ENV_VARS` holds the variables that override the credential the
local `claude` would otherwise resolve for itself. It is claude-swap's list, and
deliberately the same one. An account switcher works by keeping these out of the
environment, so the config dir decides the account.

A Docker-oriented setup run writes `CLAUDE_CODE_OAUTH_TOKEN` into `.env` as a
matter of course. A stale one silently outranks the switcher, and pins the agent
to one account. That is the failure this driver exists to avoid.

`CLAUDE_SESSION_ENV_VARS` holds Claude Code's own session environment. A
container never saw these. A host process inherits whatever launched it, and
during development the launcher is often a terminal inside Claude Code. That
terminal exports a session identity, a live control socket, and an effort
override.

The runner passes `{...process.env}` to the SDK, so all of it reaches the nested
`claude`. It then believes it is a CHILD of the launching session rather than
its own agent. One session started this way reported a 165,000-token context
window on a model whose id ends in `[1m]`. That is smaller than the standard
200k. It also carried a messaging socket pointing back at the launching session.

`CLAUDE_CONFIG_DIR` is deliberately in neither list. It is how claude-swap
selects an account. Scrubbing it would pin the agent to the default profile,
which is the same failure from the other direction.

## The working directory

The agent starts in `NANOCLAW_AGENT_DIR`, the group folder that holds its
memory and telemetry.

Nothing overrides that today, and the override was removed rather than left
speculative. `ContainerSpec` carried a `cwd` field that no composer ever set,
documented for a repo worker this tree does not have. Only the local driver
read it, so it could never be anything but the fallback.

The constraint it was written for is real and still applies to whatever adds
it back. Claude Code walks up from cwd to discover a project's `CLAUDE.md`,
`.claude/skills/` and `.claude/settings.json`. The walk is verified, and it
does not stop at a git repository root — so cwd alone decides which
repository's context an agent loads, and it must not be conflated with
`NANOCLAW_AGENT_DIR`. Moving an agent into a repository would otherwise move
its memory in there too.

## Host-owned environment

`HOST_OWNED_ENV` lists what a composed spec may never override.

`HOME` is the one that matters. Composition sets `HOME=/home/node` whenever the
spec carries a `runAs`, because inside the image that uid has no passwd entry
and HOME would resolve to `/`. Copied onto a host process it is simply wrong.
The directory does not exist, and the first thing that tries to create it dies
with `ENOTSUP` on macOS.

The quieter failure is worse. `HOME` is how the SDK finds `~/.claude`, and how
Claude Code derives its keychain entry. A spec-supplied HOME detaches the agent
from the user's harness, and from the credentials this driver exists to reuse.

The rest are listed for the same reason. They describe the container's
filesystem and identity, not this machine's.

## Mount translation

Every mount this driver understands is addressed by its containerPath, because
that is the contract the runner reads. A mount it does not recognise is not an
error. `/app/src` is the code being executed. `/app/skills` is dropped on
purpose, because shared skills reach a host agent as a plugin staged into the
session workspace, which needs no root of its own.

That second clause once claimed `/app/skills` was reached through the project
settings directory. Nothing implemented that mechanism, so every shared skill
stayed missing without one line of evidence. Unknown paths are dropped silently.

## Missing runner dependencies

`container/agent-runner` is a separate package, and NOT a pnpm workspace member.
`pnpm install` at the root never touches it. The image installs it with `bun
install --frozen-lockfile`. Under this driver the host runs the runner, and
nothing installs it.

Without a warning the failure is invisible in the worst way. Every spawn dies
instantly on `Cannot find module '@anthropic-ai/claude-agent-sdk'`. The
undelivered message stays due, and the host respawns every 2 seconds forever.
Install and service health both look fine. Only the log shows it, as an endless
wall of identical stack traces. Observed in the wild at 64 respawns before
anyone read the log.

The warning is latched rather than thrown. The driver's contract is to spawn and
report exits. A throw would change how one bad install surfaces everywhere else.
