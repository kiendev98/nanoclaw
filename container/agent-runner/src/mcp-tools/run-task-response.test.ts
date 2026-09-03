/**
 * What `run_task` TELLS THE AGENT when it returns.
 *
 * This is a contract with the model, not with a caller, and it is load-bearing
 * in a way an ordinary return value is not: whatever this string asserts, the
 * agent repeats to the human. So it must not assert anything the container is
 * not in a position to know.
 *
 * At the moment this returns, the tool has written one row to outbound.db and
 * nothing else. The host has not yet resolved `repo` against its allowlist —
 * that is where an unknown repository is refused — so no run exists and the
 * repository may not either.
 *
 * Observed live before the fix: the tool answered "Queued in <repo>", the agent
 * relayed exactly that to the human naming a repository the host rejected 9ms
 * later, and the correctly-delivered error arrived as a contradiction of a claim
 * this string had already authorised.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from '../mailbox/sqlite/connection.js';
import { runTask } from './scheduling.js';

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join(' ');
}

describe('run_task — what it claims on return', () => {
  beforeEach(() => {
    initTestSessionDb();
  });

  afterEach(() => {
    closeSessionDb();
  });

  it('does not claim the run started, and does not present the repo as accepted', async () => {
    const result = (await runTask.handler({
      repo: 'not-a-real-repo',
      instruction: 'Do the thing',
      notify: true,
    })) as { content: Array<{ type: string; text?: string }> };

    const text = textOf(result);

    // "Queued" is the specific word that caused the live failure: it reads as
    // "this is running", which is not knowable here.
    expect(text).not.toMatch(/\bQueued\b/i);
    expect(text).toMatch(/Requested/i);

    // The agent must be told the repository is still unconfirmed, so it does
    // not hand the name to the human as though the host had accepted it.
    expect(text).toMatch(/NOT CONFIRMED YET/);
    expect(text).toMatch(/do not tell them it started/i);
  });

  it('warns the fire-and-forget caller that even a failure to start stays silent', async () => {
    const result = (await runTask.handler({
      instruction: 'Do the thing',
    })) as { content: Array<{ type: string; text?: string }> };

    const text = textOf(result);

    expect(text).not.toMatch(/\bQueued\b/i);
    // Without notify the host writes no answer at all, so an unresolvable repo
    // is never reported. Saying only "nothing further will arrive" understates
    // that: the caller also never learns the run failed to start.
    expect(text).toMatch(/not even a failure to start/i);
  });
});
