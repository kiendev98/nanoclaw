/**
 * `ncl worktrees` — the manual lifecycle for task-scoped workspace worktrees.
 *
 * `ncl tasks create --repo` gets a git worktree under `WORKTREES_DIR`, and
 * nothing has ever deleted one automatically. An earlier reaper was removed
 * on purpose (282b8f6d): a directory delete on a timer is a daemon that can
 * delete a day of work. This resource is that decision's other half — the
 * human-run replacement, and the ONLY thing in NanoClaw that removes a
 * worktree.
 *
 * Two rules make it safe to type without reading the source first:
 *
 * - It never removes a worktree that holds work. `inspectWorktree` has to PROVE
 *   the removal destroys nothing — no uncommitted changes, no untracked files,
 *   no commit that exists only there, and every git call succeeded. A failed
 *   inspection is dirty.
 * - There is no `--force`, and adding one would defeat the point. When the
 *   operator has decided the work is expendable, the output hands them the git
 *   command to run themselves, so the destructive step is theirs and is typed
 *   in full.
 *
 * `--force` also never reaches git through `removeWorktree`, and `rm -rf` is
 * never used: git's own refusal to remove a dirty worktree is the second line
 * of defence behind the inspection.
 *
 * Operator-only (`hostOnly`). Enumerating and deleting host directories is a
 * filesystem-access boundary, the same class as `groups config add-mount`, so
 * no container caller reaches it regardless of `cli_scope` or approval.
 */
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { inspectWorktree, listWorktrees, removeWorktree, WORKTREES_DIR, type WorktreeEntry } from '../../worktree.js';
import { registerResource } from '../crud.js';

/** One worktree as the CLI reports it: the on-disk facts plus its owner. */
interface WorktreeReport {
  path: string;
  repo: string;
  branch: string;
  clean: boolean;
  /** Why it is clean or dirty, in words an operator can act on. */
  reason: string;
  /**
   * Name of the agent group that owns it, or null when none does.
   *
   * Keyed on `agent_groups.workspace_path`, which is unread now that the
   * delivery action that wrote it is gone (see migration 027's header) — so
   * a worktree made by `ncl tasks create --repo` always reports no owner
   * here. It stays because dropping the join is a bigger change than this
   * resource's own cleanup, not because the join still finds anything.
   */
  owner: string | null;
  /** Agent group id of the owner, or null. */
  owner_id: string | null;
}

/**
 * The exact command an operator runs when they have decided the work in a
 * dirty worktree is expendable.
 *
 * Printed instead of offering a `--force` flag. The destructive step stays a
 * thing a human types in full, in a tool whose reflog they already know.
 */
function forceCommand(worktree: string): string {
  return `git -C ${worktree} worktree remove --force ${worktree}`;
}

/**
 * Every worktree on disk, joined to the agent group that owns it, if any.
 *
 * Driven by the DIRECTORY, not by `agent_groups`: `ncl groups delete` leaves
 * the worktree behind, so a table-driven listing would never mention an
 * orphan again. An orphan gets the same cleanliness proof as any other entry —
 * losing its owner does not make its commits disposable.
 */
async function reportWorktrees(): Promise<WorktreeReport[]> {
  const groups = await getAllAgentGroups();
  const owners = new Map(groups.filter((g) => g.workspace_path).map((g) => [g.workspace_path as string, g]));

  return listWorktrees().map((entry: WorktreeEntry) => {
    const owner = owners.get(entry.path);
    return {
      path: entry.path,
      repo: entry.repo,
      branch: entry.branch,
      clean: entry.state.clean,
      reason: entry.state.reason,
      owner: owner?.name ?? null,
      owner_id: owner?.id ?? null,
    };
  });
}

function formatList(rows: WorktreeReport[]): string {
  if (rows.length === 0) return `No worktrees under ${WORKTREES_DIR}.`;

  const lines: string[] = [`${rows.length} worktree(s) under ${WORKTREES_DIR}:`, ''];
  for (const row of rows) {
    lines.push(`${row.clean ? 'clean' : 'DIRTY'}  ${row.path}`);
    lines.push(`       repo: ${row.repo}   branch: ${row.branch}`);
    lines.push(`       owner: ${row.owner ? `${row.owner} (${row.owner_id})` : 'none — the agent group is gone'}`);
    lines.push(`       ${row.reason}`);
    if (!row.clean) lines.push(`       keep it, or remove it yourself: ${forceCommand(row.path)}`);
    lines.push('');
  }
  const dirty = rows.filter((row) => !row.clean).length;
  lines.push(
    dirty === 0
      ? '`ncl worktrees prune` would remove all of them.'
      : `\`ncl worktrees prune\` would remove ${rows.length - dirty} and skip ${dirty}.`,
  );
  return lines.join('\n');
}

/** What one `prune` run did, per worktree. */
interface PruneResult {
  removed: string[];
  skipped: { path: string; reason: string; remove_it_yourself: string }[];
  failed: { path: string; error: string }[];
}

function formatPrune(result: PruneResult): string {
  const lines: string[] = [];

  lines.push(result.removed.length > 0 ? `Removed ${result.removed.length} clean worktree(s):` : 'Removed nothing.');
  for (const path of result.removed) lines.push(`  ${path}`);

  if (result.skipped.length > 0) {
    lines.push('');
    lines.push(`Kept ${result.skipped.length} worktree(s) that hold work:`);
    for (const skip of result.skipped) {
      lines.push(`  ${skip.path}`);
      lines.push(`    ${skip.reason}`);
      lines.push(`    remove it yourself: ${skip.remove_it_yourself}`);
    }
  }

  if (result.failed.length > 0) {
    lines.push('');
    lines.push(`Failed to remove ${result.failed.length} worktree(s):`);
    for (const failure of result.failed) lines.push(`  ${failure.path}: ${failure.error}`);
  }

  return lines.join('\n');
}

/**
 * Remove the clean worktrees among `rows`, keeping the rest.
 *
 * Re-inspects each candidate immediately before removing it. The listing that
 * produced `rows` is a snapshot, and a worker can write a file between the two
 * — a second proof costs one git call and is the difference between a race and
 * a deleted afternoon.
 */
function pruneWorktrees(rows: WorktreeReport[]): PruneResult {
  const result: PruneResult = { removed: [], skipped: [], failed: [] };

  for (const row of rows) {
    const state = row.clean ? inspectWorktree(row.path) : { clean: false, reason: row.reason };
    if (!state.clean) {
      result.skipped.push({ path: row.path, reason: state.reason, remove_it_yourself: forceCommand(row.path) });
      continue;
    }
    try {
      removeWorktree(row.path);
      result.removed.push(row.path);
    } catch (err) {
      result.failed.push({ path: row.path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

registerResource({
  name: 'worktree',
  plural: 'worktrees',
  // No table: a worktree is a DIRECTORY, and the directory is the only record
  // of it. `operations` is empty, so nothing here ever reads this name — it is
  // required by ResourceDef and names where the truth lives.
  table: '(filesystem)',
  description:
    `Git worktree of a task-scoped workspace, under ${WORKTREES_DIR}. Created by ` +
    '`ncl tasks create --repo` and removed only here, by hand — nothing deletes one automatically. ' +
    'OPERATOR-ONLY: not runnable from inside a container.',
  idColumn: 'path',
  columns: [
    { name: 'path', type: 'string', description: 'Absolute worktree path.' },
    { name: 'repo', type: 'string', description: 'Repository it checks out.' },
    { name: 'branch', type: 'string', description: 'Branch it has checked out.' },
    { name: 'clean', type: 'boolean', description: 'True when removing it would destroy nothing.' },
    { name: 'reason', type: 'string', description: 'Why it is clean or dirty.' },
    { name: 'owner', type: 'string', description: 'Worker agent group that owns it, or null when the group is gone.' },
    { name: 'owner_id', type: 'string', description: 'Agent group id of the owner, or null.' },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      hostOnly: true,
      description:
        'List every worker worktree on disk: path, repository, branch, the worker agent group that owns it, ' +
        'and whether removing it would destroy work.\n\n' +
        'A worktree with no owner is an orphan — its agent group was deleted — and it is judged by exactly the ' +
        'same cleanliness rules, because losing its owner does not make its commits disposable. ' +
        'A DIRTY entry names what it holds (uncommitted changes, untracked files, or commits that exist ' +
        'nowhere else) and prints the git command to remove it anyway.',
      args: [],
      examples: ['# What is on disk, and what `prune` would do with it:\nncl worktrees list'],
      handler: async () => reportWorktrees(),
      formatHuman: (data) => formatList(data as WorktreeReport[]),
    },
    prune: {
      access: 'approval',
      hostOnly: true,
      description:
        'Remove every CLEAN worker worktree and keep the rest.\n\n' +
        'A worktree is removed only when git proves the removal destroys nothing: no uncommitted changes, ' +
        'no untracked files, no commit that exists only there, and every git call succeeded. Anything else ' +
        'is kept and reported with the reason and the git command to remove it by hand. There is deliberately ' +
        'no --force: `git worktree remove --force` is a thing an operator types in full, not a flag an ' +
        'automation can pass.\n\n' +
        'Removing a worktree does not delete its branch, so a clean removal loses nothing even in hindsight. ' +
        'Exits non-zero only when a removal FAILED — skipping work is the normal outcome, not an error.',
      args: [],
      examples: ['# Reclaim the disk of finished workers, keeping anything unmerged:\nncl worktrees prune'],
      handler: async () => {
        const result = pruneWorktrees(await reportWorktrees());
        // A failed removal is the one outcome that must reach the shell as a
        // non-zero exit. The whole report travels in the message, so the
        // operator still sees what was removed and what was kept.
        if (result.failed.length > 0) throw new Error(formatPrune(result));
        return result;
      },
      formatHuman: (data) => formatPrune(data as PruneResult),
    },
    remove: {
      access: 'approval',
      hostOnly: true,
      description:
        'Remove ONE worker worktree by path, under the same proof `prune` uses.\n\n' +
        'Pass the path as the target (`ncl worktrees remove <path>`) or as --path. A worktree that holds ' +
        'work is refused, and the refusal names the git command that would remove it anyway.',
      args: [{ name: 'path', type: 'string', description: 'Absolute worktree path (from `ncl worktrees list`).' }],
      examples: [`# Remove one finished worktree:\nncl worktrees remove ${WORKTREES_DIR}/saber-nanoclaw-abc123`],
      handler: async (args) => {
        const target = (args.path ?? args.id) as string | undefined;
        if (!target) throw new Error('a worktree path is required — run `ncl worktrees list` to see them');

        const rows = await reportWorktrees();
        const row = rows.find((candidate) => candidate.path === target);
        if (!row) {
          throw new Error(
            `no worktree at ${target} — run \`ncl worktrees list\` to see what is under ${WORKTREES_DIR}`,
          );
        }

        const result = pruneWorktrees([row]);
        if (result.failed.length > 0) throw new Error(formatPrune(result));
        if (result.skipped.length > 0) throw new Error(formatPrune(result));
        return result;
      },
      formatHuman: (data) => formatPrune(data as PruneResult),
    },
  },
});
