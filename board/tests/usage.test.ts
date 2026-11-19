import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { S, buildState } from '../src/board/state';
import { UsageMeters } from '../src/components/shell/Controls';
import type { Usage } from '../src/types';
import { crew } from './build';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 17, 9, 0);
const win = (utilization: number) => ({ utilization, resetsAt: NOW + 60 * MIN });
const row = (body: Record<string, unknown>) => ({ ...body, _id: 'usage', _v: 'v1' });
/** HH:MM in this machine's time zone, as the sidebar shows it. */
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);

afterEach(() => {
  S.usage = null;
  S.macUsage = null;
});

describe('plan usage', () => {
  it('takes the windows the Mate session read on this Mac when they are newer than crew/usage, and keeps the Mate guard', () => {
    S.usage = row({ status: 'allowed_warning', fiveHour: win(0.2), sevenDay: win(0.3), updatedAt: NOW - 8 * 60 * MIN, guarded: true, guardReason: '7d over 90%' });
    S.macUsage = { fiveHour: win(0.41), sevenDay: win(0.34), updatedAt: NOW - 2 * MIN };
    expect(buildState().usage).toMatchObject({ status: 'allowed', fiveHour: win(0.41), sevenDay: win(0.34), updatedAt: NOW - 2 * MIN, guarded: true, guardReason: '7d over 90%' });
  });

  it('keeps crew/usage when it is the newer one, or the Mac has none', () => {
    S.usage = row({ status: 'allowed', fiveHour: win(0.5), sevenDay: win(0.6), updatedAt: NOW - MIN });
    S.macUsage = { fiveHour: win(0.41), sevenDay: win(0.34), updatedAt: NOW - 2 * MIN };
    expect(buildState().usage).toMatchObject({ fiveHour: win(0.5), sevenDay: win(0.6), updatedAt: NOW - MIN });
    S.macUsage = null;
    expect(buildState().usage).toMatchObject({ fiveHour: win(0.5), updatedAt: NOW - MIN });
  });

  it('uses the Mac windows before the Mate has ever written crew/usage', () => {
    S.macUsage = { fiveHour: win(0.41), sevenDay: null, updatedAt: NOW - MIN };
    expect(buildState().usage).toMatchObject({ status: 'allowed', fiveHour: win(0.41), sevenDay: null, guarded: false });
  });

  it("a guard-only crew/usage never hides the Mac's windows, and the limit comes from the windows shown", () => {
    S.usage = row({ guarded: true, guardReason: 'Usage guard', updatedAt: NOW });
    S.macUsage = { fiveHour: win(1), sevenDay: win(0.34), updatedAt: NOW - 3 * MIN };
    expect(buildState().usage).toMatchObject({ status: 'rejected', fiveHour: win(1), guarded: true });
    S.usage = row({ status: 'rejected', fiveHour: win(1), sevenDay: win(0.9), updatedAt: NOW - 9 * 60 * MIN });
    S.macUsage = { fiveHour: win(0.2), sevenDay: win(0.3), updatedAt: NOW - MIN };
    expect(buildState().usage).toMatchObject({ status: 'allowed', fiveHour: win(0.2) });
  });
});

describe('usage meters', () => {
  const draw = (usage: Partial<Usage>) =>
    renderToStaticMarkup(createElement(UsageMeters, { crew: crew({ usage: { ...crew().usage, fiveHour: win(0.41), sevenDay: win(0.34), ...usage } }), now: NOW }));

  it('say when the numbers were read once they are over 30 minutes old', () => {
    const at = NOW - 31 * MIN;
    expect(draw({ updatedAt: at })).toMatch(new RegExp(`<p class="usage-note stale" title="Usage last read [^"]*${hhmm(at)}">as of ${hhmm(at)}</p>`));
  });

  it('show no time while the numbers are fresh, or when no read time is known', () => {
    expect(draw({ updatedAt: NOW - 29 * MIN })).not.toContain('as of');
    expect(draw({ updatedAt: 0 })).not.toContain('as of');
  });
});
