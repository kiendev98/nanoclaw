import type { Migration } from './index.js';

/**
 * `workspace_path` on `agent_groups` — the agent's working directory, when it
 * is not the group folder.
 *
 * This is the one column that decides which repository an agent stands in.
 * Claude Code resolves project memory and project skills by walking UP from
 * cwd — verified empirically, and it does NOT stop at a git repository root —
 * so cwd, and only cwd, decides whose `CLAUDE.md`, `.claude/skills/` and
 * `.claude/settings.json` a session loads. The value reaches the spawn as
 * `ContainerSpec.cwd` and `container.json`, which the driver and the runner
 * read respectively (commit a5622111).
 *
 * Deliberately NOT on `container_configs`. That table holds runtime knobs an
 * operator tunes (provider, model, limits); this is the group's identity — the
 * repository this worker exists to work in — and it is written once, at
 * creation, by the same action that creates the worktree.
 *
 * NULL is the default and it is not a missing value: it means "cwd is the group
 * folder", which is exactly what every group did before this column existed. No
 * backfill, so every existing group keeps its behaviour byte for byte.
 */
export const migration025: Migration = {
  version: 25,
  name: 'agent-group-workspace-path',
  async up(db) {
    await db.exec(`ALTER TABLE agent_groups ADD COLUMN workspace_path TEXT;`);
  },
};
