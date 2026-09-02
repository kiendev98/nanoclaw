export interface TaskContent {
  prompt: string;
  script: string | null;
  originSessionId: string | null;
  /**
   * Repository NAME this series works in, as the operator allowlist resolves
   * it. Never a path — see `resolveRepo`.
   */
  repo: string | null;
  /**
   * Correlation id of a `run_task` caller waiting on this occurrence, or null
   * for a scheduled fire that nobody is waiting on.
   *
   * Its presence is the whole delivery contract: with an id the run's result
   * is written back to the requester, without one the run is fire-and-forget.
   */
  requestId: string | null;
  /** Epoch ms at which that caller's poll expires, or null if it never polled. */
  waitUntil: number | null;
}

/** Decode the storage-neutral task content envelope. */
export function parseTaskContent(raw: string): TaskContent {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      script: typeof parsed.script === 'string' ? parsed.script : null,
      originSessionId: typeof parsed.originSessionId === 'string' ? parsed.originSessionId : null,
      repo: typeof parsed.repo === 'string' ? parsed.repo : null,
      requestId: typeof parsed.requestId === 'string' ? parsed.requestId : null,
      waitUntil: typeof parsed.waitUntil === 'number' ? parsed.waitUntil : null,
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- LEGACY-COMPAT(v1-tasks): plain-string content predating the JSON envelope
  } catch {
    return { prompt: raw, script: null, originSessionId: null, repo: null, requestId: null, waitUntil: null };
  }
}
