/**
 * A leading channel mention must not hide a slash command.
 *
 * Slack swallows a bare leading '/' — the client eats it as its own slash
 * command — so tagging the bot is the ONLY way a user can send one. That makes
 * the text `<@U123> /compact`, which failed `text.startsWith('/')` here and in
 * the host gate. Every slash command silently degraded to prose: `/compact` and
 * `/context` stopped acting on the session, and `poll-loop` handed the SDK a
 * sentence rather than a command.
 *
 * The strip is duplicated in `src/mention-strip.ts` on the host, because the
 * two are separate build units. Both sides are tested.
 */
import { describe, expect, it } from 'bun:test';

import type { MessageInRow } from './db/messages-in.js';
import { categorizeMessage, isClearCommand, SESSION_ECHO_CHANNEL } from './formatter.js';
import { stripLeadingMentions } from './mention-strip.js';

function chat(text: string, channelType: string | null = 'slack'): MessageInRow {
  return {
    id: 'm1',
    seq: 1,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    status: 'pending',
    process_after: null,
    recurrence: null,
    series_id: null,
    tries: 0,
    trigger: 1,
    platform_id: 'C1',
    channel_type: channelType,
    thread_id: null,
    content: JSON.stringify({ text, senderId: 'slack:U9' }),
    source_session_id: null,
    on_wake: 0,
  };
}

describe('stripLeadingMentions', () => {
  it('strips a plain mention', () => {
    expect(stripLeadingMentions('<@U123> /compact')).toBe('/compact');
  });

  it('strips a labelled mention', () => {
    expect(stripLeadingMentions('<@U123|nanobot> /compact')).toBe('/compact');
  });

  it('strips several mentions', () => {
    expect(stripLeadingMentions('<@U123> <@W456|bot> /clear')).toBe('/clear');
  });

  it('strips the colon or comma Slack leaves after a mention', () => {
    expect(stripLeadingMentions('<@U123>: /cost')).toBe('/cost');
    expect(stripLeadingMentions('<@U123>, /cost')).toBe('/cost');
  });

  it('leaves text with no leading mention exactly as it was', () => {
    expect(stripLeadingMentions('/compact')).toBe('/compact');
    expect(stripLeadingMentions('hello there')).toBe('hello there');
  });

  it('leaves a mid-sentence mention alone — that is prose, not an address', () => {
    expect(stripLeadingMentions('tell <@U123> to stop')).toBe('tell <@U123> to stop');
  });

  it('keeps the rest of the message', () => {
    expect(stripLeadingMentions('<@U123> /blueprint add a login page')).toBe('/blueprint add a login page');
  });
});

describe('categorizeMessage sees through a mention', () => {
  it('categorizes an admin command sent with a mention', () => {
    const info = categorizeMessage(chat('<@U123> /compact'));
    expect(info.category).toBe('admin');
    expect(info.command).toBe('/compact');
  });

  it('hands the SDK the command without the mention', () => {
    // poll-loop pushes `info.text` STRAIGHT to the SDK as the prompt. A mention
    // left on the front is not a command the SDK dispatches.
    expect(categorizeMessage(chat('<@U123|nanobot> /blueprint ship it')).text).toBe('/blueprint ship it');
  });

  it('categorizes a filtered command sent with a mention', () => {
    expect(categorizeMessage(chat('<@U123> /help')).category).toBe('filtered');
  });

  it('categorizes an unknown command as passthrough', () => {
    const info = categorizeMessage(chat('<@U123> /blueprint'));
    expect(info.category).toBe('passthrough');
    expect(info.command).toBe('/blueprint');
  });

  it('keeps the mention on ordinary prose — who was addressed is information', () => {
    const info = categorizeMessage(chat('<@U123> what is up'));
    expect(info.category).toBe('none');
    expect(info.text).toBe('<@U123> what is up');
  });

  it('still refuses to execute a command copied in from another session', () => {
    const echo = chat('<@U123> /clear', SESSION_ECHO_CHANNEL);
    expect(categorizeMessage(echo).category).toBe('none');
  });
});

describe('isClearCommand sees through a mention', () => {
  it('recognizes a mentioned /clear', () => {
    // A second, independent read of the same text. If it disagreed with
    // categorizeMessage, `@bot /clear` would reach the SDK with the session
    // never cleared.
    expect(isClearCommand(chat('<@U123> /clear'))).toBe(true);
  });

  it('still recognizes a bare /clear', () => {
    expect(isClearCommand(chat('/clear'))).toBe(true);
  });

  it('does not fire on prose', () => {
    expect(isClearCommand(chat('<@U123> please clear the backlog'))).toBe(false);
  });

  it('does not fire on a cross-session echo', () => {
    expect(isClearCommand(chat('<@U123> /clear', SESSION_ECHO_CHANNEL))).toBe(false);
  });
});
