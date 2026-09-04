import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { answerWorkerQuestion, askPrincipal, delegateTask, finishTask, sendProgressNote } from './worker.js';

function actions(): Array<Record<string, unknown>> {
  return getUndeliveredMessages().map((m) => JSON.parse(m.content) as Record<string, unknown>);
}

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('delegate_task', () => {
  it('carries the repository, the task, and the conversation it was asked in', async () => {
    const result = await delegateTask.handler({ repository: 'nanoclaw', task: 'add a --dry-run flag' });

    expect(result.isError).not.toBe(true);
    expect(actions()[0]).toMatchObject({
      action: 'worker_delegate',
      repository: 'nanoclaw',
      task: 'add a --dry-run flag',
    });
  });

  // A2: the repository is named, never inferred — so a missing one is a
  // question for the person, not a default the tool picks.
  it('refuses without a repository, and writes nothing', async () => {
    const result = await delegateTask.handler({ task: 'add a --dry-run flag' });

    expect(result.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('refuses without a task', async () => {
    expect((await delegateTask.handler({ repository: 'nanoclaw' })).isError).toBe(true);
  });

  // A3: there is no transcript or history argument to pass, so a caller cannot
  // hand over the conversation even by accident.
  it('accepts no argument beyond the repository and the task', () => {
    expect(Object.keys(delegateTask.tool.inputSchema.properties ?? {}).sort()).toEqual(['repository', 'task']);
  });
});

describe('ask_principal', () => {
  it('writes the question and tells the caller not to wait', async () => {
    const result = await askPrincipal.handler({ question: 'skip the seed step?' });

    expect(actions()[0]).toMatchObject({ action: 'worker_ask_principal', question: 'skip the seed step?' });
    expect(result.content[0]?.text).toContain('End your turn');
  });

  it('refuses an empty question', async () => {
    expect((await askPrincipal.handler({})).isError).toBe(true);
  });
});

describe('answer_worker_question', () => {
  // C5: an answer names the question it answers, so no ordinary message can
  // stand in for one.
  it('requires the question id it answers', async () => {
    expect((await answerWorkerQuestion.handler({ answer: 'yes' })).isError).toBe(true);
    expect((await answerWorkerQuestion.handler({ questionId: 'wq-1' })).isError).toBe(true);

    await answerWorkerQuestion.handler({ questionId: 'wq-1', answer: 'yes' });
    expect(actions()[0]).toMatchObject({ action: 'worker_answer_question', questionId: 'wq-1', answer: 'yes' });
  });
});

describe('send_progress_note', () => {
  // B4: fire-and-forget. It returns rather than waiting, so a note cannot
  // block the work it is reporting on.
  it('returns without waiting for anything', async () => {
    const result = await sendProgressNote.handler({ text: 'tests pass' });

    expect(result.isError).not.toBe(true);
    expect(actions()[0]).toMatchObject({ action: 'worker_progress_note', text: 'tests pass' });
  });
});

describe('finish_task', () => {
  it('carries the final statement as the report', async () => {
    await finishTask.handler({ report: 'opened PR #482' });

    expect(actions()[0]).toMatchObject({ action: 'worker_done', text: 'opened PR #482' });
  });

  it('refuses to finish with nothing to say', async () => {
    expect((await finishTask.handler({})).isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
