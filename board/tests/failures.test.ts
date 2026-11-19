import { describe, expect, it, vi } from 'vitest';
import { dbErrorText } from '../src/lib/api';
import { helperFailure, missingToolNote } from '../src/lib/helperTools';
import { keepSubscribed, resubscribeDelay } from '../src/lib/subscribe';

describe('helperFailure', () => {
  it('spots a helper without the tool, whatever the code', () => {
    expect(helperFailure('costs', { code: '-32601', message: 'Method not found' }, false)).toEqual({ code: 'missing_tool', message: missingToolNote('costs'), unreachable: false, ambiguous: false });
    expect(helperFailure('risk', { code: 'tool_error', message: 'Unknown tool: risk' }, false).code).toBe('missing_tool');
  });

  it('shows the helper’s own words from a tool_error envelope', () => {
    const f = helperFailure('diff', { code: 'tool_error', message: 'generic', result: { content: [{ type: 'text', text: ' git failed: no such ref ' }] } }, false);
    expect(f).toEqual({ code: 'tool_error', message: 'git failed: no such ref', unreachable: false, ambiguous: false });
    expect(helperFailure('diff', { code: 'tool_error' }, false).message).toContain('“diff”');
  });

  it('says a declined write never ran', () => {
    expect(helperFailure('approve', { code: 'cancelled' }, true).message).toContain('nothing was done');
    expect(helperFailure('diff', { code: 'cancelled' }, false).message).toBe('Cancelled.');
  });

  it('marks the codes that put the helper out of reach', () => {
    for (const code of ['server_not_connected', 'not_in_manifest', 'not_granted', 'capability_disabled', 'blocked_by_policy', 'user_changed']) {
      expect(helperFailure('ping', { code }, false).unreachable).toBe(true);
    }
    expect(helperFailure('ping', { code: 'approval_required' }, false).unreachable).toBe(false);
  });

  it('flags a write with an unknown outcome as ambiguous, but not a read', () => {
    const w = helperFailure('config_set', { code: 'server_unavailable', message: 'timed out' }, true);
    expect(w.ambiguous).toBe(true);
    expect(w.message).toContain('may or may not have run');
    expect(w.message).toContain('timed out');
    expect(helperFailure('crew_state', { code: 'server_unavailable' }, false).ambiguous).toBe(false);
  });

  it('treats a missing or odd code as upstream_error', () => {
    expect(helperFailure('ping', {}, false).code).toBe('upstream_error');
    expect(helperFailure('ping', { code: 42, message: 'boom' }, false)).toEqual({ code: 'upstream_error', message: 'The Keelcrew helper didn’t answer: boom', unreachable: false, ambiguous: false });
    expect(helperFailure('approve', { code: '' }, true).ambiguous).toBe(true);
  });
});

describe('dbErrorText', () => {
  it('is null for anything that isn’t a db rejection', () => {
    for (const e of [null, undefined, 'text', 42, new Error('x'), { message: 'no code' }, { code: 7 }]) expect(dbErrorText(e)).toBeNull();
  });

  it('words each code, with the detail when there is one', () => {
    expect(dbErrorText({ code: 'quota_exceeded', message: ' 5 MB used ' })).toContain('full (5 MB used)');
    expect(dbErrorText({ code: 'quota_exceeded', message: '   ' })).toContain('full. Ask the Mate');
    expect(dbErrorText({ code: 'resource_exhausted' })).toContain('too many changes');
    expect(dbErrorText({ code: 'invalid_argument', message: 'bad field' })).toBe('The board’s database refused that change: bad field');
    expect(dbErrorText({ code: 'transform_error' })).toBe('The board’s database refused that change.');
    expect(dbErrorText({ code: 'revoked' })).toContain('lost access');
    expect(dbErrorText({ code: 'not_granted' })).toContain('can’t change the board');
    expect(dbErrorText({ code: 'unavailable', message: 'offline' })).toBe('The board’s database didn’t answer (offline). Try again in a moment.');
  });
});

describe('keepSubscribed', () => {
  type OnError = (e: { code?: string; message?: string }) => void;
  function harness() {
    let t = 0;
    const errors: OnError[] = [];
    const stops = vi.fn();
    const waits: number[] = [];
    let pending: (() => void) | null = null;
    const onRevoked = vi.fn();
    const log = vi.fn();
    keepSubscribed('crew', (onError) => (errors.push(onError), stops), {
      onRevoked,
      log,
      now: () => t,
      wait: (ms, fn) => {
        waits.push(ms);
        pending = fn;
      },
    });
    const fail = (code?: string, livedMs = 0) => {
      t += livedMs;
      errors[errors.length - 1]({ code, message: 'x' });
    };
    const reopen = () => {
      const fn = pending;
      pending = null;
      fn?.();
    };
    return { errors, stops, waits, onRevoked, log, fail, reopen, hasPending: () => pending !== null };
  }

  it('reopens an ended listener after a pause that doubles with each failure in a row', () => {
    const h = harness();
    for (let i = 0; i < 8; i++) {
      h.fail('unavailable');
      h.reopen();
    }
    expect(h.errors).toHaveLength(9);
    expect(h.waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(h.stops).toHaveBeenCalledTimes(8);
  });

  it('starts at 15 s for a busy store and counts again after a listener that lived half a minute', () => {
    const h = harness();
    h.fail('resource_exhausted');
    h.reopen();
    h.fail('unavailable');
    h.reopen();
    h.fail('unavailable', 31_000);
    expect(h.waits).toEqual([15_000, 2_000, 1_000]);
    expect(resubscribeDelay(1, 'resource_exhausted')).toBe(15_000);
  });

  it('acts on one terminal error per listener, and a missing code still reopens', () => {
    const h = harness();
    const first = h.errors[0];
    first({});
    first({ code: 'unavailable' });
    expect(h.waits).toEqual([1_000]);
    expect(h.stops).toHaveBeenCalledTimes(1);
  });

  it('stops for good on revoked, and logs a refusal instead of retrying it', () => {
    const r = harness();
    r.fail('revoked');
    expect(r.onRevoked).toHaveBeenCalledTimes(1);
    expect(r.hasPending()).toBe(false);
    for (const code of ['invalid_argument', 'transform_error']) {
      const h = harness();
      h.fail(code);
      expect(h.log).toHaveBeenCalledWith(expect.stringContaining(`crew subscription was refused (${code})`));
      expect(h.hasPending()).toBe(false);
      expect(h.onRevoked).not.toHaveBeenCalled();
    }
  });
});
