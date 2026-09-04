/**
 * Local driver — runs the agent as a host process instead of a container.
 *
 * This driver provides NO isolation. The permission boundary is the user
 * account the host runs as. It exists because credentials, the account pool
 * and the VPN all work only on the host.
 *
 * See `docs/local-driver.md` for what it trades away and why.
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { resolveClaudeExecutable } from './claude-executable.js';
import { log } from '../log.js';

import {
  LABELS,
  asFailureError,
  labelsForKey,
  specInvalid,
  validateSpec,
  type DriverCapabilities,
  type MountPolicy,
  type SessionDriver,
  type SessionEvent,
  type SessionExecSpec,
  type SessionHandle,
  type SessionKey,
  type SessionSnapshot,
  type SessionSpec,
  type SessionStatus,
  type SessionWatch,
} from './types.js';

/**
 * Environment variables that override the credential the local `claude` would
 * otherwise resolve for itself. Scrubbed from every spawn.
 *
 * This list is claude-swap's `AUTH_OVERRIDE_ENV_VARS`, and deliberately so. An
 * account switcher works by keeping these out of the environment. The config
 * dir then decides the account.
 *
 * A Docker-oriented setup run writes `CLAUDE_CODE_OAUTH_TOKEN` into `.env` as a
 * matter of course. A stale one silently outranks the switcher. It pins the
 * agent to one account, which is the failure this driver exists to avoid.
 * Scrubbing is not optional.
 */
const AUTH_OVERRIDE_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
] as const;

/**
 * Claude Code's own session environment, scrubbed before the agent starts.
 *
 * A container never saw these. A host process inherits whatever launched it.
 * During development the likely launcher is a terminal inside Claude Code. That
 * terminal exports a session identity, a live control socket, and an effort
 * override.
 *
 * The runner passes `{...process.env}` to the SDK. Every one of them reaches the
 * nested `claude`. It then believes it is a CHILD of the launching session
 * rather than its own agent.
 *
 * That is not cosmetic. One session started this way reported a 165,000-token
 * context window on a model whose id ends in `[1m]`. That is smaller than the
 * standard 200k. It also carried a messaging socket pointing back at the
 * launching session.
 *
 * `CLAUDE_CONFIG_DIR` is deliberately NOT here. It is how claude-swap selects an
 * account. Scrubbing it would pin the agent to the default profile, which is the
 * failure `AUTH_OVERRIDE_ENV_VARS` prevents from the other direction.
 */
const CLAUDE_SESSION_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_AGENT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CLAUDE_JOB_DIR',
] as const;

/**
 * Remove every inherited Claude identity from an agent's environment.
 *
 * Exported so the two lists can be asserted without spawning a process. The
 * failure both prevent is silent: the agent starts, answers, and is simply
 * wrong about which account it is or whose session it belongs to.
 */
/**
 * The agent's working directory.
 *
 * NOT necessarily the group folder. Claude Code walks up from cwd to discover a
 * project's `CLAUDE.md`, `.claude/skills/` and `.claude/settings.json`. The walk
 * is verified, and it does not stop at a git repository root. So cwd is the only
 * lever that puts an agent inside a repository with that repository's context.
 *
 * `NANOCLAW_AGENT_DIR` stays the agent's own state directory (memory, footer
 * telemetry) in every case. The two were one value, which is precisely what
 * bound an agent to a single repository.
 *
 * Falls back to the group folder, so an install that sets no override keeps
 * its exact previous behaviour.
 */
export function resolveSpawnCwd(specCwd: string | undefined, rootEnv: NodeJS.ProcessEnv): string | undefined {
  return (specCwd ?? '').trim() || rootEnv.NANOCLAW_AGENT_DIR;
}

export function stripInheritedClaudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const key of AUTH_OVERRIDE_ENV_VARS) delete env[key];
  for (const key of CLAUDE_SESSION_ENV_VARS) delete env[key];
  return env;
}

/**
 * Environment the host owns, which a composed spec may never override.
 *
 * `HOME` is the one that matters, and the reason this list exists. Composition
 * sets `HOME=/home/node` whenever the spec carries a `runAs`
 * (`container-runner.ts`). Inside the image that uid has no passwd entry, so
 * HOME would otherwise resolve to `/`.
 *
 * Copied onto a host process it is simply wrong. The directory does not exist.
 * The first thing that tries to create it dies with `ENOTSUP` on macOS.
 *
 * The quieter failure is worth naming. `HOME` is how the SDK finds `~/.claude`,
 * and how Claude Code derives its keychain entry. A spec-supplied HOME does not
 * only break a mkdir. It detaches the agent from the user's harness, and from
 * the credentials this driver exists to reuse.
 *
 * The rest are listed for the same reason. They describe the container's
 * filesystem and identity, not this machine's.
 */
const HOST_OWNED_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR'] as const;

/** Container paths this driver understands, mapped to the runner's root variables. */
const ROOT_ENV_BY_CONTAINER_PATH: Record<string, string> = {
  '/workspace': 'NANOCLAW_WORKSPACE_DIR',
  '/workspace/agent': 'NANOCLAW_AGENT_DIR',
  '/app/.nanoclaw-session.json': 'NANOCLAW_SESSION_CONTEXT_PATH',
};

const EXTRA_PREFIX = '/workspace/extra/';
const AGENT_ROLE = 'agent';
const POLL_INTERVAL_MS = 2_000;

interface SessionRecord {
  name: string;
  pid: number;
  key: SessionKey;
  labels: Record<string, string>;
  startedAt: string;
}

/** Is this pid still ours and alive? Signal 0 tests without delivering. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sessionName(key: SessionKey): string {
  return `nanoclaw-local-${key.agentGroupId}-${key.sessionId}`;
}

export interface LocalDriverOptions {
  policy: MountPolicy;
  /** Absolute path to the agent runner's entry module. */
  runnerEntry: string;
  /** Interpreter for the runner. Bun, because the runner imports `bun:sqlite`. */
  runtimeBin?: string;
}

export class LocalSessionDriver implements SessionDriver {
  readonly kind = 'local';

  readonly #policy: MountPolicy;
  readonly #runnerEntry: string;
  readonly #runtimeBin: string;
  readonly #records = new Map<string, SessionRecord>();
  readonly #children = new Map<string, ChildProcess>();
  readonly #exits = new Map<string, number | null>();
  #watchTimer: NodeJS.Timeout | undefined;
  #listeners = new Set<(event: SessionEvent) => void>();
  /** Latched so the preflight below reports once, not once per respawn. */
  #runnerDepsReported = false;

  constructor(options: LocalDriverOptions) {
    this.#policy = options.policy;
    this.#runnerEntry = options.runnerEntry;
    this.#runtimeBin = options.runtimeBin ?? 'bun';
  }

  capabilities(): DriverCapabilities {
    return {
      // The host composes runtimeTier 'container' for every spec. Accepting it
      // is not a claim to containment — see the file header. The seam has no
      // 'process' tier to name, and refusing every spec would be a worse lie
      // than accepting one and reporting the reductions below.
      isolationTiers: ['container'],
      admissionEnforced: false,
      // Nothing is enforced. 'declarative' is the closer of the two
      // available values. There is no topology to inspect, because there is
      // one network namespace and it is the host's.
      networkPolicy: 'declarative',
      encryptedVolumes: false,
      // A host process has no per-session cgroup, so every resource cap in the
      // spec is unrealizable. Naming them is what stops a feature from gating
      // on driver identity instead of on capability.
      unrealized: ['memoryMb', 'cpus', 'pidsLimit', 'shmSizeMb'],
      sharedNetworkNamespace: true,
      auxiliaryContainers: false,
      imageBuild: false,
    };
  }

  async ensureReady(): Promise<void> {
    if (!fs.existsSync(this.#runnerEntry)) {
      throw asFailureError({
        kind: 'spec-invalid',
        retryable: false,
        detail: `agent runner entry not found: ${this.#runnerEntry}`,
      });
    }
    log.warn(
      'Local driver active — the agent runs as a host process with no isolation, on this account and this network',
      { kind: this.kind },
    );
  }

  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    validateSpec(spec, this.#policy, this.capabilities());

    const agents = spec.containers.filter((c) => c.role === AGENT_ROLE);
    if (spec.containers.length !== 1 || agents.length !== 1) {
      // capabilities().auxiliaryContainers is false, so composition already
      // gates this. Refusing here too is the backstop the seam asks for:
      // silently dropping a composed container is semantic loss, not a
      // degradation.
      throw specInvalid(`local driver realizes exactly one 'agent' container, got ${spec.containers.length}`);
    }

    const container = agents[0]!;
    const name = sessionName(spec.key);
    const rootEnv = this.#deriveRootEnv(spec, container.mounts);

    const record: SessionRecord = {
      name,
      pid: 0,
      key: spec.key,
      labels: { ...labelsForKey(spec.key, AGENT_ROLE, spec.labels), ...(container.labels ?? {}) },
      startedAt: '',
    };
    this.#records.set(name, record);

    return new LocalSessionHandle({
      key: spec.key,
      name,
      driver: this,
      spawn: () => this.#spawnRunner(name, spec, container.env, container.contributedEnv, rootEnv),
      stopGraceSeconds: spec.stopGraceSeconds,
    });
  }

  /**
   * Translate the composed mounts into the runner's root variables.
   *
   * Every mount this driver understands is addressed by its containerPath,
   * because that is the contract the runner reads. A mount it does not
   * recognise is not an error.
   *
   * `/app/src` is the code being executed. `/app/skills` is dropped on purpose.
   * The shared skills reach a host agent as a plugin staged into the session
   * workspace, which needs no root of its own (`container-runner.ts`,
   * `stageSkillsPlugin`).
   *
   * That second clause once claimed `/app/skills` was reached through the
   * project settings directory. Nothing implemented that mechanism. Every
   * shared skill therefore stayed missing, without one line of evidence.
   * Unknown paths are dropped silently, and this comment is the record.
   */
  #deriveRootEnv(spec: SessionSpec, mounts: SessionSpec['containers'][number]['mounts']): Record<string, string> {
    const env: Record<string, string> = {};
    const extras: Array<{ name: string; hostPath: string }> = [];

    for (const mount of mounts) {
      const variable = ROOT_ENV_BY_CONTAINER_PATH[mount.containerPath];
      if (variable) {
        env[variable] = mount.hostPath;
        continue;
      }
      if (mount.containerPath.startsWith(EXTRA_PREFIX)) {
        extras.push({ name: mount.containerPath.slice(EXTRA_PREFIX.length), hostPath: mount.hostPath });
        continue;
      }
      // Nested read-only views over the group directory need no action.
      // On the host, container.json and CLAUDE.md already sit at those paths
      // inside the group directory. The read-only part is the reduction this
      // driver reports rather than fakes.
    }

    if (!env.NANOCLAW_AGENT_DIR) {
      throw specInvalid('no mount at /workspace/agent — the runner has no working directory');
    }
    if (!env.NANOCLAW_WORKSPACE_DIR) {
      throw specInvalid('no mount at /workspace — the runner has no mailbox');
    }

    env.NANOCLAW_EXTRA_DIR = this.#realizeExtras(spec.key, extras);
    return env;
  }

  /**
   * Build the one directory of symlinks this driver does plant.
   *
   * `/workspace/extra` entries are leaves — a whole repository per entry, with
   * nothing else mounted inside it — so a link is exact. Rebuilt per prepare so
   * a removed mount disappears rather than lingering from a previous session.
   */
  #realizeExtras(key: SessionKey, extras: Array<{ name: string; hostPath: string }>): string {
    const dir = path.join(this.#sessionStateDir(key.installSlug), `${key.agentGroupId}__${key.sessionId}`, 'extra');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const extra of extras) {
      fs.symlinkSync(extra.hostPath, path.join(dir, extra.name));
    }
    return dir;
  }

  #sessionStateDir(installSlug: string): string {
    return path.join(this.#policy.dataRoot, 'local-sessions', installSlug);
  }

  /**
   * Say once, loudly, that the runner has no dependencies installed.
   *
   * `container/agent-runner` is a separate package, and NOT a pnpm workspace
   * member. `pnpm install` at the root never touches it. The image installs it
   * with `bun install --frozen-lockfile` (`container/Dockerfile`). Under this
   * driver the host runs the runner, and nothing installs it.
   *
   * Without this the failure is invisible in the worst way. Every spawn dies
   * instantly on `Cannot find module '@anthropic-ai/claude-agent-sdk'`. The
   * undelivered message stays due, and the host respawns every 2 seconds
   * forever.
   *
   * Install and service health both look fine. Only the log shows it, as an
   * endless wall of identical stack traces rather than one diagnosable event.
   * Observed in the wild at 64 respawns before anyone read the log.
   *
   * Latched rather than thrown. The driver's contract is to spawn and report
   * exits. A throw here would change how one bad install surfaces everywhere
   * else. One actionable line beats a new failure mode.
   */
  #reportMissingRunnerDeps(name: string): void {
    if (this.#runnerDepsReported) return;
    const runnerRoot = path.resolve(path.dirname(this.#runnerEntry), '..');
    const sdk = path.join(runnerRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
    if (fs.existsSync(sdk)) {
      this.#runnerDepsReported = true;
      return;
    }
    this.#runnerDepsReported = true;
    log.error(
      'Agent runner has no dependencies installed — every session will fail instantly and respawn in a loop. ' +
        `Fix with: (cd ${runnerRoot} && bun install --frozen-lockfile)`,
      { name, runnerRoot },
    );
  }

  #spawnRunner(
    name: string,
    spec: SessionSpec,
    containerEnv: Record<string, string>,
    contributedEnv: Record<string, string> | undefined,
    rootEnv: Record<string, string>,
  ): ChildProcess {
    const hostEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) hostEnv[k] = v;
    }

    const env = { ...hostEnv };
    // Composed env first, then the contributed lane, matching the seam's
    // stated collision order.
    Object.assign(env, containerEnv, contributedEnv ?? {}, rootEnv);

    // Then take the host's own back, unconditionally. These describe this
    // machine, and a spec composed for a container cannot know them.
    for (const key of HOST_OWNED_ENV) {
      if (hostEnv[key] !== undefined) env[key] = hostEnv[key];
      else delete env[key];
    }
    stripInheritedClaudeEnv(env);

    // Warned here and delivered elsewhere: `container-config.ts` writes the
    // resolved path into `container.json`, which is the runner's config
    // channel. This spawn is the last moment a human-visible warning is worth
    // emitting, because the failure that follows happens inside the child.
    if (!resolveClaudeExecutable(env.PATH)) {
      log.warn('No `claude` on PATH — the agent will fail with the container default path', { name });
    }

    this.#reportMissingRunnerDeps(name);

    const child = spawn(this.#runtimeBin, ['run', this.#runnerEntry], {
      cwd: resolveSpawnCwd(spec.containers.find((c) => c.role === 'agent')?.cwd, rootEnv),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    child.stdout?.on('data', (chunk: Buffer) => log.info(`[${name}] ${chunk.toString().trimEnd()}`));
    child.stderr?.on('data', (chunk: Buffer) => log.info(`[${name}] ${chunk.toString().trimEnd()}`));

    child.once('exit', (code) => {
      this.#exits.set(name, code);
      this.#children.delete(name);
      this.#emit({ key: spec.key, kind: 'terminal' });
    });

    this.#children.set(name, child);
    const record = this.#records.get(name);
    if (record) {
      record.pid = child.pid ?? 0;
      record.startedAt = new Date().toISOString();
      this.#writeRecord(spec.key.installSlug, record);
    }
    return child;
  }

  #writeRecord(installSlug: string, record: SessionRecord): void {
    const dir = this.#sessionStateDir(installSlug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${record.name}.json`), JSON.stringify(record, null, 2));
  }

  #removeRecord(installSlug: string, name: string): void {
    fs.rmSync(path.join(this.#sessionStateDir(installSlug), `${name}.json`), { force: true });
  }

  /** @internal — used by the handle. */
  _child(name: string): ChildProcess | undefined {
    return this.#children.get(name);
  }

  /** @internal — used by the handle. */
  _exitCode(name: string): number | null | undefined {
    return this.#exits.get(name);
  }

  /** @internal — used by the handle. */
  _record(name: string): SessionRecord | undefined {
    return this.#records.get(name);
  }

  /** @internal — used by the handle. */
  _forget(installSlug: string, name: string): void {
    this.#children.delete(name);
    this.#records.delete(name);
    this.#removeRecord(installSlug, name);
  }

  /** @internal — used by the handle. */
  _emitTerminal(key: SessionKey): void {
    this.#emit({ key, kind: 'terminal' });
  }

  async listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    const dir = this.#sessionStateDir(installSlug);
    if (!fs.existsSync(dir)) return [];

    const snapshots: SessionSnapshot[] = [];
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      let record: SessionRecord;
      try {
        record = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf-8')) as SessionRecord;
      } catch {
        // A truncated record is residue, not a session. reapResidue clears it.
        continue;
      }
      const alive = record.pid > 0 && isAlive(record.pid);
      // A record whose pid is gone is a corpse, and the seam is explicit that
      // a self-exited runtime must never be dressed up as live.
      snapshots.push({ handle: this.#adopt(record), phase: alive ? 'running' : 'terminal' });
    }
    return snapshots;
  }

  #adopt(record: SessionRecord): SessionHandle {
    return new LocalSessionHandle({
      key: record.key,
      name: record.name,
      driver: this,
      spawn: () => {
        throw specInvalid('an adopted local session cannot be started again — it has no spec');
      },
      stopGraceSeconds: 10,
      adoptedPid: record.pid,
    });
  }

  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch {
    this.#listeners.add(onEvent);

    // One subscription per driver, never one per session. A host process
    // reports its own exit synchronously through the child handle. The poll
    // exists only for records this process did not spawn, such as a host
    // restarted under an adopted session. A slow interval is therefore correct.
    this.#watchTimer ??= setInterval(() => {
      void this.listSessions(installSlug)
        .then((snapshots) => {
          for (const snapshot of snapshots) {
            if (snapshot.phase === 'terminal') this.#emit({ key: snapshot.handle.key, kind: 'terminal' });
          }
        })
        .catch((error: unknown) => log.warn('Local session poll failed', { error: String(error) }));
    }, POLL_INTERVAL_MS);
    this.#watchTimer.unref?.();

    return {
      stop: () => {
        this.#listeners.delete(onEvent);
        if (this.#listeners.size === 0 && this.#watchTimer) {
          clearInterval(this.#watchTimer);
          this.#watchTimer = undefined;
        }
      },
    };
  }

  #emit(event: SessionEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        log.warn('Local session event listener threw', { error: String(error) });
      }
    }
  }

  async reapResidue(installSlug: string): Promise<void> {
    const dir = this.#sessionStateDir(installSlug);
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const file = path.join(dir, entry);
      try {
        const record = JSON.parse(fs.readFileSync(file, 'utf-8')) as SessionRecord;
        if (record.pid > 0 && isAlive(record.pid)) continue;
      } catch {
        // fall through — an unparseable record is residue by definition
      }
      fs.rmSync(file, { force: true });
    }
  }
}

interface HandleOptions {
  key: SessionKey;
  name: string;
  driver: LocalSessionDriver;
  spawn: () => ChildProcess;
  stopGraceSeconds: number;
  adoptedPid?: number;
}

class LocalSessionHandle implements SessionHandle {
  readonly key: SessionKey;
  readonly name: string;

  readonly #driver: LocalSessionDriver;
  readonly #spawn: () => ChildProcess;
  readonly #stopGraceSeconds: number;
  readonly #adoptedPid: number | undefined;
  #started = false;

  constructor(options: HandleOptions) {
    this.key = options.key;
    this.name = options.name;
    this.#driver = options.driver;
    this.#spawn = options.spawn;
    this.#stopGraceSeconds = options.stopGraceSeconds;
    this.#adoptedPid = options.adoptedPid;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const child = this.#spawn();
    if (!child.pid) {
      throw asFailureError({ kind: 'runtime-unavailable', retryable: true });
    }
  }

  async status(): Promise<SessionStatus> {
    const exitCode = this.#driver._exitCode(this.name);
    if (exitCode !== undefined && exitCode !== null && exitCode !== 0) {
      return { phase: 'failed', failure: { kind: 'started-then-died', retryable: false, exitCode } };
    }
    if (exitCode === 0) return { phase: 'stopped' };

    const child = this.#driver._child(this.name);
    if (child?.pid && isAlive(child.pid)) return { phase: 'running' };
    if (this.#adoptedPid && isAlive(this.#adoptedPid)) return { phase: 'running' };
    if (!this.#started && !this.#adoptedPid) return { phase: 'ready' };
    return { phase: 'stopped' };
  }

  async stop(reason: string): Promise<void> {
    const pid = this.#driver._child(this.name)?.pid ?? this.#adoptedPid;
    log.info('Stopping local session', { name: this.name, reason, pid });

    if (pid && isAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone between the liveness check and the signal
      }
      const deadline = Date.now() + this.#stopGraceSeconds * 1000;
      while (isAlive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (isAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // raced with its own exit
        }
      }
    }

    this.#driver._forget(this.key.installSlug, this.name);
    this.#driver._emitTerminal(this.key);
  }

  execSpec(command: string[]): SessionExecSpec {
    // Pure description, never performed here — the terminal belongs to the
    // caller's stdio. There is no container to enter, so an attach is the
    // command itself, run in the agent's working directory.
    const record = this.#driver._record(this.name);
    const cwd = record ? path.dirname(path.join(record.name)) : process.cwd();
    const args = ['-c', 'cd "$0" && exec "$@"', cwd, ...command];
    return { bin: '/bin/sh', argsTty: args, argsPlain: args };
  }
}

/** Every label key a realized local session carries, for adoption. */
export const LOCAL_SESSION_LABELS = LABELS;
