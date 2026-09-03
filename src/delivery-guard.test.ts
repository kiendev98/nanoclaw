/**
 * Tests for `runGuarded`'s hold-with-no-requestHold branch.
 *
 * `DeliveryGuardSpec.requestHold` became optional so a guarded action can
 * define no admin-approval path at all — an action whose decide fn always
 * allows or denies has no hold branch to build a card for. Every registered
 * action today either takes that shape or supplies a requestHold, so this
 * path is unreachable from any registered action; it exists as a fail-closed
 * backstop against a future decide fn that returns hold with no hold handler
 * wired up. A synthetic guarded action is the only way to reach it directly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runGuarded, type DeliveryGuardSpec } from './delivery-guard.js';
import { defineGuardedAction, HOLD, ALLOW } from './guard/index.js';
import { log } from './log.js';
import type { Session } from './types.js';

const SESSION = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runGuarded — hold with no requestHold configured', () => {
  it('denies rather than silently dropping the request, and logs why', async () => {
    const action = defineGuardedAction({
      action: `test.hold-no-handler-${Date.now()}`,
      decide: () => HOLD('synthetic hold with no requestHold to answer it'),
    });
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const onDeny = vi.fn();
    const spec: DeliveryGuardSpec = { guardAction: action, onDeny };

    await runGuarded(action.action, spec, vi.fn(), {}, SESSION, null);

    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onDeny.mock.calls[0][2]).toContain('no admin-approval path is configured');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('no requestHold configured'),
      expect.objectContaining({ action: action.action }),
    );
  });

  it('still runs the handler when the same spec allows', async () => {
    const action = defineGuardedAction({
      action: `test.hold-no-handler-allow-${Date.now()}`,
      decide: () => ALLOW('nothing to hold on this branch'),
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    const spec: DeliveryGuardSpec = { guardAction: action };

    await runGuarded(action.action, spec, handler, {}, SESSION, null);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
