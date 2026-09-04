/**
 * The prelude-row writer, shared by the two seeding sources. It owns exactly
 * the parts that must not drift between them: the wire envelope the container
 * formatter parses, and the rule that the newest entry is delivered whole.
 * Everything caller-specific — collection, row ids, label — stays out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const written: Array<Record<string, unknown>> = [];
/** Row index (1-based) whose write should throw. 0 disables the failure. */
let failOnRow = 0;

vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: async (agentGroupId: string, sessionId: string, msg: Record<string, unknown>) => {
    if (failOnRow > 0 && written.length + 1 === failOnRow + 1) throw new Error('mailbox io');
    written.push({ agentGroupId, sessionId, ...msg });
  },
}));

const { writePreludeRows, preludeSurface, LAST_ENTRY_MAX_CHARS } = await import('./prelude.js');

const ROOM_MG = { id: 'mg-room', channel_type: 'slack', platform_id: 'slack:C1', is_group: 1 } as never;
const DM_MG = { id: 'mg-dm', channel_type: 'slack', platform_id: 'slack:D1', is_group: 0 } as never;

interface Row {
  timestamp: string;
  sender: string;
  senderId: string;
  text: string;
  self: boolean;
  id?: string;
}

function row(text: string, over: Partial<Row> = {}): Row {
  return {
    timestamp: '2026-09-03T05:00:00.000Z',
    sender: 'Kien',
    senderId: 'U079',
    text,
    self: false,
    ...over,
  };
}

async function write(rows: Row[]): Promise<void> {
  await writePreludeRows('ag-1', 'sess-1', rows, {
    surface: 'channel-timeline',
    label: 'this thread, before the agent was brought in',
    rowId: (r, index) => `${r.id ?? 'row'}:${index}`,
  });
}

interface ParsedRow {
  text: string;
  sender: string;
  senderId: string;
  self?: boolean;
  echo: { surface: string; label: string; sentAt: string };
}

function parsed(index: number): ParsedRow {
  return JSON.parse(written[index].content as string) as ParsedRow;
}

beforeEach(() => {
  written.length = 0;
  failOnRow = 0;
});

describe('preludeSurface', () => {
  it('seeds a group conversation under channel-timeline', () => {
    expect(preludeSurface(ROOM_MG)).toBe('channel-timeline');
  });

  it('seeds a DM under dm-timeline', () => {
    expect(preludeSurface(DM_MG)).toBe('dm-timeline');
  });
});

describe('writePreludeRows', () => {
  it('writes every row as a trigger=0 session-echo, in the order given', async () => {
    await write([row('first'), row('second'), row('third')]);

    expect(written.map((r) => r.trigger)).toEqual([false, false, false]);
    expect(written.map((r) => r.channelType)).toEqual(['session-echo', 'session-echo', 'session-echo']);
    expect(written.map((r) => r.kind)).toEqual(['chat', 'chat', 'chat']);
    expect([0, 1, 2].map((i) => parsed(i).text)).toEqual(['first', 'second', 'third']);
  });

  it('delivers the newest entry whole and caps the earlier ones', async () => {
    const long = 'x'.repeat(6000);

    await write([row(long), row(long)]);

    expect(parsed(0).text).toBe(`${'x'.repeat(500)}…`);
    expect(parsed(1).text).toBe('x'.repeat(LAST_ENTRY_MAX_CHARS));
  });

  it('treats a lone row as the newest, so it is delivered whole', async () => {
    await write([row('y'.repeat(3000))]);

    expect(parsed(0).text).toBe('y'.repeat(3000));
  });

  it('ages rows from when they were seeded, not from when the message was sent', async () => {
    // The echo pruner drops pending rows older than 7 days by this column. A
    // thread wired weeks after it started is the case thread history exists
    // for, so the platform send time here would sweep the whole prelude
    // before the container's first poll.
    const before = Date.now();

    await write([row('old', { timestamp: '2026-01-01T00:00:00.000Z' })]);

    const stamped = Date.parse(written[0].timestamp as string);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  it('keeps the real send time in echo.sentAt, which is what the agent sees', async () => {
    await write([row('old', { timestamp: '2026-01-01T00:00:00.000Z' })]);

    expect(parsed(0).echo.sentAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('stamps one seeding time across the whole batch, so seq and time agree', async () => {
    await write([row('a'), row('b'), row('c')]);

    const stamps = new Set(written.map((r) => r.timestamp));
    expect(stamps.size).toBe(1);
  });

  it('carries the surface and label onto every row', async () => {
    await write([row('a'), row('b')]);

    for (const index of [0, 1]) {
      expect(parsed(index).echo.surface).toBe('channel-timeline');
      expect(parsed(index).echo.label).toBe('this thread, before the agent was brought in');
    }
  });

  it('stamps self only on the agent’s own rows, so the formatter says "you"', async () => {
    await write([row('mine', { self: true }), row('theirs')]);

    expect(parsed(0).self).toBe(true);
    expect(parsed(1).self).toBeUndefined();
  });

  it('lets the caller name each row from the row and its index', async () => {
    await write([row('a', { id: 'm1' }), row('b', { id: 'm2' })]);

    expect(written.map((r) => r.id)).toEqual(['m1:0', 'm2:1']);
  });

  it('writes nothing when there is nothing to seed', async () => {
    await write([]);

    expect(written).toEqual([]);
  });

  it('returns how many rows landed', async () => {
    const count = await writePreludeRows('ag-1', 'sess-1', [row('a'), row('b')], {
      surface: 'channel-timeline',
      label: 'l',
      rowId: (_r, index) => `r${index}`,
    });

    expect(count).toBe(2);
  });

  it('reports a partial write instead of throwing, so no second prelude follows', async () => {
    // A caller that reads zero writes another prelude on top, and the
    // container's per-prompt cap cannot absorb two.
    failOnRow = 2;

    const count = await writePreludeRows('ag-1', 'sess-1', [row('a'), row('b'), row('c')], {
      surface: 'channel-timeline',
      label: 'l',
      rowId: (_r, index) => `r${index}`,
    });

    expect(count).toBe(2);
    expect(written.map((r) => r.id)).toEqual(['r0', 'r1']);
  });
});
