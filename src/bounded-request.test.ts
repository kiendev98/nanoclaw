/**
 * The three delivery modes, expressed as two independent fields.
 *
 * `requestId` decides whether an answer is written at all; `waitUntil` decides
 * whether a wake accompanies it. Keeping them independent is what made
 * fire-and-forget free — see the table in `bounded-request.ts`.
 */
import { describe, expect, it } from 'vitest';

import { callerStoppedWaiting, LATE_MARGIN_MS, parseBoundedRequest } from './bounded-request.js';

describe('parseBoundedRequest', () => {
  it('reads both correlation fields', () => {
    expect(parseBoundedRequest({ requestId: 'r-1', waitUntil: 42 })).toEqual({ requestId: 'r-1', waitUntil: 42 });
  });

  it('treats an absent requestId as nobody listening', () => {
    expect(parseBoundedRequest({}).requestId).toBe('');
  });

  it('trims, so a whitespace-only id is not mistaken for a correlation', () => {
    expect(parseBoundedRequest({ requestId: '   ' }).requestId).toBe('');
  });

  it('ignores a non-numeric deadline rather than coercing it', () => {
    expect(parseBoundedRequest({ waitUntil: 'soon' }).waitUntil).toBeNull();
  });
});

describe('callerStoppedWaiting', () => {
  it('treats an absent deadline as not waiting, so the answer arrives by wake', () => {
    expect(callerStoppedWaiting({ requestId: 'r-1', waitUntil: null })).toBe(true);
  });

  it('leaves a caller alone while its poll is still comfortably open', () => {
    expect(callerStoppedWaiting({ requestId: 'r-1', waitUntil: Date.now() + LATE_MARGIN_MS * 10 })).toBe(false);
  });

  it('reports an expired deadline as no longer waiting', () => {
    expect(callerStoppedWaiting({ requestId: 'r-1', waitUntil: Date.now() - 1 })).toBe(true);
  });

  it('wakes inside the late margin, where the race is unwinnable either way', () => {
    // A duplicate wake costs one turn. The other error costs the whole
    // request, silently.
    expect(callerStoppedWaiting({ requestId: 'r-1', waitUntil: Date.now() + LATE_MARGIN_MS / 2 })).toBe(true);
  });
});
