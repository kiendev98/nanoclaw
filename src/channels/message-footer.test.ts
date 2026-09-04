/**
 * The footer contract, which no compiler can enforce.
 *
 * `OutboundMessage.content` is `unknown`, so an adapter that reads the field
 * wrongly fails silently and drops the footer. These cases are the only thing
 * standing behind the shape.
 */
import { describe, expect, it } from 'vitest';

import { appendFooter, readFooter } from './message-footer.js';

describe('readFooter', () => {
  it('reads the field the runner writes', () => {
    expect(readFooter({ text: 'done', footer: 'Wego #1 · opus-5' })).toBe('Wego #1 · opus-5');
  });

  it('trims, so a stray newline never becomes three blank lines', () => {
    expect(readFooter({ text: 'done', footer: '  Wego #1  \n' })).toBe('Wego #1');
  });

  it.each([
    ['no footer field', { text: 'done' }],
    ['a non-string footer', { text: 'done', footer: 42 }],
    ['a whitespace footer', { text: 'done', footer: '   ' }],
    ['a string body', 'plain text'],
    ['null', null],
    ['undefined', undefined],
  ])('returns empty for %s', (_label, content) => {
    expect(readFooter(content)).toBe('');
  });
});

describe('appendFooter', () => {
  it('separates body and footer by exactly one blank line', () => {
    expect(appendFooter('done', 'Wego #1')).toBe('done\n\nWego #1');
  });

  it('returns the body untouched when there is no footer', () => {
    expect(appendFooter('done', '')).toBe('done');
  });

  it('does not turn an empty body into a lone footer', () => {
    // A message with no text is not a message. Emitting the telemetry line by
    // itself would deliver a footer with nothing above it.
    expect(appendFooter('', 'Wego #1')).toBe('');
  });
});
