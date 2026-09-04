/**
 * The first name in a series that nothing has claimed yet.
 *
 * Two things here need one: the folder an agent group gets on disk, and the
 * local name a worker knows a lent conversation by. Both count upward from a
 * preferred name, and holding that in one place is what stops the two drifting
 * when the scheme changes.
 */
export async function firstFreeName(
  preferred: string,
  isTaken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  let candidate = preferred;
  let suffix = 2;
  while (await isTaken(candidate)) {
    candidate = `${preferred}-${suffix}`;
    suffix++;
  }
  return candidate;
}
