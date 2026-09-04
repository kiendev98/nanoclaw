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
