/**
 * Scheduling module — the parts of task scheduling that register themselves.
 *
 * The rest of `modules/scheduling/` is imported directly by core (the CLI's
 * task resource, the recurrence grid, the run log), so it needs no barrel
 * entry. Only the two things that must happen at import time live here: the
 * schema this module owns, and the delivery action `run_task` answers on.
 *
 * `run_task` is registered unguarded for the same reason `spawn_worker` was:
 * it starts a session the caller may already start by other means, in the
 * caller's own agent group. What it may reach is bounded by the task series
 * that already exists and by `NANOCLAW_PROJECT_ROOTS`, not by a decision taken
 * here.
 */
import { registerMigration } from '../../db/migrations/index.js';
import { moduleSchedulingTaskWorkspace } from '../../db/migrations/module-scheduling-task-workspace.js';

registerMigration(moduleSchedulingTaskWorkspace);
