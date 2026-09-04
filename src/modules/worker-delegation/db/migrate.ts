import { registerMigration } from '../../../db/migrations/index.js';
import { moduleWorkerDelegation } from '../../../db/migrations/module-worker-delegation.js';

let registered = false;

/**
 * Put this module's tables into the migration run.
 *
 * They arrive with the module rather than with core, which is what makes the
 * table guards on every core reach into this module reachable: an install that
 * never imports this barrel never creates them.
 *
 * Idempotent because a test asks for the tables without importing the barrel,
 * and `registerMigration` refuses a name twice. In production the ESM cache
 * already makes it once.
 */
export function registerWorkerMigration(): void {
  if (registered) return;
  registerMigration(moduleWorkerDelegation);
  registered = true;
}
