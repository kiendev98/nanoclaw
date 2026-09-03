/**
 * The agent-lane loop breaker.
 *
 * These test the budget itself rather than a full route, because the failure
 * it prevents is not a wrong value anywhere — it is a pair of agents each
 * behaving correctly, at machine speed, forever. What has to hold is the
 * arithmetic: a conversation stays under budget, a runaway crosses it, the
 * two directions are independent, and time alone restores the lane.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { _a2aWakeAllowed, _resetA2aWakesForTesting } from './agent-route.js';

const A = 'ag-worker';
const B = 'ag-orchestrator';
const BUDGET = 20;
const WINDOW_MS = 60_000;

beforeEach(() => {
  _resetA2aWakesForTesting();
});

describe('agent-lane wake budget', () => {
  it('lets an ordinary exchange through untouched', () => {
    // A real worker/orchestrator turn pair is a handful of messages spread
    // over minutes. Nothing here should ever notice the guard exists.
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      expect(_a2aWakeAllowed(A, B, now + i * 5_000)).toBe(true);
    }
  });

  it('stops the observed runaway inside the first window', () => {
    // The real loop ran at ~1/second, alternating, for 93 seconds. One
    // direction of that is ~27 wakes per minute against a budget of 20.
    const now = Date.now();
    const verdicts = Array.from({ length: 27 }, (_, i) => _a2aWakeAllowed(A, B, now + i * 1_000));

    expect(verdicts.slice(0, BUDGET).every((v) => v)).toBe(true);
    expect(verdicts.slice(BUDGET).every((v) => !v)).toBe(true);
  });

  it('throttles one direction without gagging the reply path', () => {
    // Keyed per ORDERED pair on purpose: a worker flooding its orchestrator
    // must not silence the orchestrator's answers, or the guard would turn a
    // recoverable burst into a wedged worker.
    const now = Date.now();
    for (let i = 0; i <= BUDGET; i++) _a2aWakeAllowed(A, B, now + i);

    expect(_a2aWakeAllowed(A, B, now + 100)).toBe(false);
    expect(_a2aWakeAllowed(B, A, now + 100)).toBe(true);
  });

  it('leaves an unrelated pair alone', () => {
    const now = Date.now();
    for (let i = 0; i <= BUDGET; i++) _a2aWakeAllowed(A, B, now + i);

    expect(_a2aWakeAllowed('ag-other', B, now + 100)).toBe(true);
  });

  it('restores the lane once the window passes, with no reset hook', () => {
    // The reason this is a sliding window and not a hop count: this lane
    // never sees the human message that would reset a counter, so a spent
    // budget would strand a long-lived pair permanently.
    const now = Date.now();
    for (let i = 0; i <= BUDGET; i++) _a2aWakeAllowed(A, B, now + i);
    expect(_a2aWakeAllowed(A, B, now + 200)).toBe(false);

    expect(_a2aWakeAllowed(A, B, now + WINDOW_MS + 1_000)).toBe(true);
  });

  it('counts a throttled attempt, so a wedged pair cannot spend its way out', () => {
    // A refused wake still happened as an attempt. If refusals did not count,
    // a pair at 1/second would drop below budget the moment it was throttled
    // and immediately be let through again — a guard that oscillates instead
    // of holding.
    const now = Date.now();
    for (let i = 0; i <= BUDGET + 5; i++) _a2aWakeAllowed(A, B, now + i);

    expect(_a2aWakeAllowed(A, B, now + BUDGET + 10)).toBe(false);
  });
});
