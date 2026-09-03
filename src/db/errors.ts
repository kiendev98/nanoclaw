/**
 * True when `ALTER TABLE … ADD COLUMN` failed because the column is there.
 *
 * The narrow shape matters: this exists so a migration can be idempotent
 * against an install that already carries a column from a branch whose
 * migration was later reverted. Widening it to any ALTER failure would turn a
 * real schema error into a silent no-op, which is the failure mode a
 * migration must never have.
 *
 * PRAGMA and `sqlite_master` are the obvious alternative and are banned from
 * portable migrations (see `migrations/portability.test.ts`), so catching the
 * engine's own answer is the portable way to ask.
 */
export function isDuplicateColumn(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String(error.code) : '';
  // Postgres 42701 = duplicate_column. SQLite has no dedicated code and
  // reports a generic error, so its message is the only signal.
  if (code === '42701') return true;
  return error instanceof Error && /duplicate column name/i.test(error.message);
}

/** True when a statement failed because a unique/primary-key constraint won. */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String(error.code) : '';
  if (
    code === '23505' ||
    code.startsWith('SQLITE_CONSTRAINT_UNIQUE') ||
    code.startsWith('SQLITE_CONSTRAINT_PRIMARYKEY')
  ) {
    return true;
  }
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
