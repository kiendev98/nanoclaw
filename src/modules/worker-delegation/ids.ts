/**
 * Row ids for this module's tables.
 *
 * One generator, because five copies of the same expression is five places for
 * the shape to drift. The prefix is what makes a stray id legible in a log line
 * without a join.
 */
export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
