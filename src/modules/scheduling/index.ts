/**
 * Scheduling module — the part of task scheduling that registers itself.
 *
 * The rest of `modules/scheduling/` is imported directly by core (the CLI's
 * task resource, the recurrence grid, the run log, the workspace helpers), so
 * it needs no barrel entry. Only the delivery action does, because a delivery
 * action has to exist before the first outbound row that names it.
 *
 * The schema this module owns is deliberately NOT registered here. A
 * registered migration only exists once the barrel is imported, which is the
 * host entry point alone, so it would be invisible to every test and to any
 * tool that opens the database without booting the host — see
 * `db/migrations/027-scheduling-task-workspace.ts`.
 *
 * Unguarded, for the same reason `spawn_worker` was: it starts a run of a task
 * series that already exists, in the caller's own agent group, which the
 * caller may already start through `ncl tasks run`. What that run may reach is
 * bounded by the series and by `NANOCLAW_PROJECT_ROOTS`, not by a decision
 * taken here.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { runTask } from './run-task.js';

registerDeliveryAction(
  'run_task',
  runTask,
  unguarded("queues a run of an existing task series in the caller's own agent group; no privileged effect"),
);
