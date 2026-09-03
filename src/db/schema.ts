/**
 * Reference copy of the current v2 schema.
 * Read this to understand the DB structure.
 * Actual creation is done by migrations — do not use this at runtime.
 */

export const SCHEMA = `
-- Agent workspaces: folder, skills, CLAUDE.md.
-- All workspaces are equal; privilege lives on users, not groups.
-- Container config lives in the container_configs table (see migration 014).
-- workspace_path (migration 025) is the agent's WORKING directory when it is
-- not the group folder — a git worktree of some repository, so the session
-- loads that repository's CLAUDE.md, .claude/skills/ and .claude/settings.json
-- (Claude Code walks UP from cwd for all three). NULL means "cwd is the group
-- folder", which is what every group did before the column existed. The folder
-- stays the agent's STATE directory either way: memory and telemetry never
-- follow cwd into a repo.
-- origin_session_id (migration 026) is unread now: it named the session a
-- repo-scoped worker was created for, back when a delivery action minted one
-- per (repo, thread) pair. That action is gone (migration 027 deleted every
-- row it had set), and the column stays only because dropping it would
-- falsify migration 026 -- a released migration's identity is permanent.
-- Not an FK: an ON DELETE CASCADE would have deleted the worker when its
-- origin session row went, orphaning a worktree that may hold uncommitted
-- work.
CREATE TABLE agent_groups (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  folder            TEXT NOT NULL UNIQUE,
  agent_provider    TEXT,
  created_at        TEXT NOT NULL,
  workspace_path    TEXT,
  origin_session_id TEXT
);

CREATE INDEX idx_agent_groups_origin_session ON agent_groups(origin_session_id)
  WHERE origin_session_id IS NOT NULL;

-- Platform groups/channels. unknown_sender_policy governs what happens
-- when a sender we've never seen before posts in this chat.
-- The column DEFAULT is "strict" (inherited from migration 001), but it
-- only matters if something inserts without specifying the field, which no
-- current callsite does. Router auto-create hardcodes "request_approval"
-- (see src/router.ts:151); setup scripts pick per context.
-- instance = adapter-instance name; the default instance IS the channel
-- type (migration 016 backfill), so single-instance installs never see it.
-- Inbound lookups are exact-on-instance; outbound lookups default-first.
CREATE TABLE messaging_groups (
  id                    TEXT PRIMARY KEY,
  channel_type          TEXT NOT NULL,
  platform_id           TEXT NOT NULL,
  instance              TEXT NOT NULL,
  name                  TEXT,
  is_group              INTEGER DEFAULT 0,
  unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
                        -- 'strict' | 'request_approval' | 'public'
  created_at            TEXT NOT NULL,
  denied_at             TEXT,
  UNIQUE(channel_type, platform_id, instance)
);

-- Which agent groups handle which messaging groups.
-- engage_mode / engage_pattern / sender_scope / ignored_message_policy are
-- the four orthogonal axes that together replace v1's opaque trigger_rules
-- JSON + response_scope enum. See docs/v1-vs-v2/ACTION-ITEMS.md item 1.
CREATE TABLE messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
  engage_mode            TEXT NOT NULL DEFAULT 'mention',
                         -- 'pattern' | 'mention' | 'mention-sticky'
  engage_pattern         TEXT,   -- regex; required when engage_mode='pattern';
                                 -- '.' means "match every message" (the "always" flavor)
  sender_scope           TEXT NOT NULL DEFAULT 'all',    -- 'all' | 'known'
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',   -- 'drop' | 'accumulate'
  session_mode           TEXT DEFAULT 'shared',
  priority               INTEGER DEFAULT 0,
  threads                INTEGER, -- NULL = inherit the channel adapter's declared
                                  -- thread default; 1/0 = per-wiring override
                                  -- (migration 019)
  created_at             TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);

-- Users are messaging-platform identifiers, namespaced: "phone:+1555...",
-- "tg:123", "discord:456", "email:a@x.com". A single human can own multiple
-- user rows if they have identifiers on unrelated channels (no linking yet).
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT,
  created_at   TEXT NOT NULL
);

-- Role grants on users. Privilege is user-level, not group-level.
--   role ∈ {owner, admin}
--   owner: always global (agent_group_id IS NULL)
--   admin: agent_group_id NULL = global, else scoped to that agent group
-- Invariant: admin @ A implies membership in A (no row needed).
CREATE TABLE user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL,
  agent_group_id TEXT REFERENCES agent_groups(id),
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
CREATE INDEX idx_user_roles_scope ON user_roles(agent_group_id, role);

-- "Known" membership in an agent group. Required for an unprivileged user
-- to interact with a workspace. Admin @ A is implicitly a member of A.
CREATE TABLE agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by       TEXT REFERENCES users(id),
  added_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);

-- Cached mapping from (user, channel) to the DM messaging group. Lets the
-- host initiate cold DMs (pairing, approvals) without reprobing the
-- platform API on every send. Populated lazily by ensureUserDm().
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);

-- Sessions: one folder = one session = one container when running
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),
  thread_id          TEXT,
  agent_provider     TEXT,
  status             TEXT DEFAULT 'active',
  container_status   TEXT DEFAULT 'stopped',
  last_active        TEXT,
  created_at         TEXT NOT NULL,
  -- Task-scoped workspace and Slack thread binding (module:scheduling:task-workspace).
  -- workspace_path is the directory this session's agent runs in; the two bound_*
  -- columns are the thread it opened, so a reply resolves back to it instead of
  -- minting a new session. All three are NULL for an ordinary chat session.
  workspace_path            TEXT,
  bound_messaging_group_id  TEXT,
  bound_root_message_id     TEXT,
  -- Who is waiting for this task session's next run to finish, as JSON. Set by
  -- run_task, read and cleared when the run's task_log arrives.
  pending_run_request       TEXT
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup ON sessions(messaging_group_id, thread_id);
CREATE INDEX idx_sessions_bound ON sessions(bound_messaging_group_id, bound_root_message_id);

-- Pending interactive questions
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  message_out_id TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  title          TEXT NOT NULL,
  options_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- Pending approvals for unknown senders (unknown_sender_policy='request_approval').
-- In-flight dedup via UNIQUE(messaging_group_id, sender_identity): a second
-- message from the same unknown sender while a card is pending is silently
-- dropped instead of spamming the admin.
CREATE TABLE pending_sender_approvals (
  id                 TEXT PRIMARY KEY,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  sender_identity    TEXT NOT NULL,    -- namespaced user id (channel_type:handle)
  sender_name        TEXT,
  original_message   TEXT NOT NULL,    -- JSON of the original InboundEvent
  approver_user_id   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  UNIQUE(messaging_group_id, sender_identity)
);
`;
